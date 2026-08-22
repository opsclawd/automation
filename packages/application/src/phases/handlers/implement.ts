import { PhaseName } from '@ai-sdlc/domain';
import type { FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import type { StepRepositoryPort } from '../../ports/step-repository-port.js';
import type { Step, RunId } from '@ai-sdlc/domain';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import { validatePlanTaskList, derivePlanTasks, extractTaskBody } from '../plan-tasks.js';
import type { TaskManifest, TaskManifestEntry } from '../plan-tasks.js';
import type { ValidationPort } from '../../ports/validation-port.js';
import type { RunWorkspaceTypecheckPort } from '../../ports/run-workspace-typecheck-port.js';
import { buildTaskValidationCommands } from '../../task-validation-commands.js';
import {
  uncommittedSourcePaths,
  formatDirtyPaths,
  unquoteGitPath,
  isUntrackedOrAddedStatusLine,
} from '../../artifacts/orchestrator-artifacts.js';

import {
  normalizeTaskPath,
  declaredTaskFiles,
  normalizedPathSet,
  hasDeclaredSurface,
  resolveEffectiveTaskScope,
  classifyTaskChanges,
} from '../../task-file-boundaries.js';
import type {
  EffectiveTaskScope,
  PrematureImplementationRecord,
  TaskChangeCandidate,
  TaskScopeClassification,
} from '../../task-file-boundaries.js';
import {
  findInheritedFormattingDebtFiles,
  isFormattingOnlyChange,
} from '../../inherited-formatting-debt.js';
import type {
  RevertScopeFilesPort,
  RevertScopeFilesResult,
} from '../../ports/revert-scope-files-port.js';
import type { DeleteWorktreeFilePort } from '../../ports/delete-worktree-file-port.js';
import { isProtectedFilePath, remediateScratchFiles } from '../../scratch-file-remediation.js';
export type { ScratchFileStepRecord, ScratchFilesReport } from '../../scratch-file-remediation.js';

interface DirtyClassification {
  permitted: string[];
  unpermitted: string[];
  protected: string[];
  exempt: string[];
  formattingDebt: string[];
}

async function classifyPhaseBoundaryDirtyPaths({
  cwd,
  dirtyPaths,
  exemptSet,
  git,
  readWorktreeFile,
}: {
  cwd: string;
  dirtyPaths: string[];
  exemptSet: ReadonlySet<string>;
  git: PhaseHandlerContext['git'];
  readWorktreeFile?: PhaseHandlerContext['readWorktreeFile'];
}): Promise<DirtyClassification> {
  const permitted: string[] = [];
  const unpermitted: string[] = [];
  const protectedFiles: string[] = [];
  const exempt: string[] = [];
  const formattingDebt: string[] = [];

  for (const p of dirtyPaths) {
    const norm = normalizeTaskPath(p);
    if (!norm) continue;
    if (isProtectedFilePath(norm)) {
      protectedFiles.push(norm);
      unpermitted.push(norm);
    } else if (exemptSet.has(norm)) {
      exempt.push(norm);
      permitted.push(norm);
    } else {
      // Check if formatting-only change by comparing worktree to HEAD via readWorktreeFile port
      let isFormattingOnly = false;
      let isIdenticalToHead = false;
      try {
        if (git?.fileContent && readWorktreeFile) {
          const worktreeContent = await readWorktreeFile(cwd, norm);
          if (worktreeContent !== undefined) {
            const headContent = await git.fileContent(cwd, 'HEAD', norm);
            if (headContent === worktreeContent) {
              isIdenticalToHead = true;
            } else {
              isFormattingOnly = isFormattingOnlyChange(norm, headContent, worktreeContent);
            }
          }
        }
      } catch {
        // Cannot determine — treat as unpermitted
      }
      if (isIdenticalToHead) {
        continue;
      }
      if (isFormattingOnly) {
        formattingDebt.push(norm);
        permitted.push(norm);
      } else {
        unpermitted.push(norm);
      }
    }
  }

  return { permitted, unpermitted, protected: protectedFiles, exempt, formattingDebt };
}

function formatProtectedDiagnostic(record: {
  revertedProtectedFiles: string[];
  removedNewlyIgnoredFilesCount: number;
}): string {
  const diagnostics: string[] = [];
  for (const file of record.revertedProtectedFiles) {
    if (file === '.gitignore') {
      if (record.removedNewlyIgnoredFilesCount > 0) {
        const count = record.removedNewlyIgnoredFilesCount;
        const s = count === 1 ? '' : 's';
        diagnostics.push(
          `.gitignore was modified without declaration, un-ignoring ${count} artifact${s}; the protected change and artifacts were reverted`,
        );
      } else {
        diagnostics.push(
          `.gitignore was modified without declaration; the protected change was reverted`,
        );
      }
    } else {
      diagnostics.push(
        `${file} was modified without declaration; the protected change was reverted`,
      );
    }
  }
  return diagnostics.join('; ');
}

interface EvaluateWorktreeStateOptions {
  cwd: string;
  git?: PhaseHandlerContext['git'] | undefined;
  preStepHead?: string | undefined;
  postStepHead?: string | undefined;
  committedFiles: string[];
  readStatus: () => Promise<string>;
  currentScope: EffectiveTaskScope;
  manifest?: TaskManifest | undefined;
  currentTaskNumber: number;
  exemptFiles?: string[] | undefined;
}

interface EvaluateWorktreeStateResult {
  classification: TaskScopeClassification;
  dirtySourcePaths: string[];
}

async function evaluateWorktreeState({
  cwd,
  git,
  preStepHead,
  postStepHead,
  committedFiles,
  readStatus,
  currentScope,
  manifest,
  currentTaskNumber,
  exemptFiles,
}: EvaluateWorktreeStateOptions): Promise<EvaluateWorktreeStateResult> {
  let hasCreatedSnapshot = false;
  let createdSet = new Set<string>();

  if (typeof git?.createdFiles === 'function' && preStepHead && postStepHead) {
    try {
      const createdFilesList = await git.createdFiles(cwd, preStepHead, postStepHead);
      if (createdFilesList !== undefined) {
        hasCreatedSnapshot = true;
        createdSet = new Set(createdFilesList.map(normalizeTaskPath).filter(Boolean));
      }
    } catch {
      hasCreatedSnapshot = false;
    }
  }

  let statusOutput = '';
  let dirtySourcePaths: string[] = [];
  let untrackedPaths = new Set<string>();
  try {
    statusOutput = await readStatus();
    untrackedPaths = new Set(
      statusOutput
        .split('\n')
        .filter(isUntrackedOrAddedStatusLine)
        .map((line) => unquoteGitPath(line.slice(3).trim()).replace(/\\/g, '/'))
        .map(normalizeTaskPath)
        .filter(Boolean),
    );
    dirtySourcePaths = uncommittedSourcePaths(statusOutput).map(normalizeTaskPath).filter(Boolean);
  } catch {
    // Status read failure is best-effort here; existing verificationError handling applies
  }

  const candidates: TaskChangeCandidate[] = [];
  for (const p of dirtySourcePaths) {
    candidates.push({
      path: p,
      tracked: !untrackedPaths.has(p) && !createdSet.has(p),
    });
  }
  for (const p of committedFiles) {
    const normP = normalizeTaskPath(p);
    if (!normP) continue;
    const isTracked = hasCreatedSnapshot ? !createdSet.has(normP) : false;
    candidates.push({ path: normP, tracked: isTracked });
  }

  const classification = classifyTaskChanges({
    candidates,
    currentScope,
    ...(manifest?.tasks ? { manifestTasks: manifest.tasks } : {}),
    ...(manifest ? { manifest } : {}),
    currentTaskNumber,
    ...(exemptFiles !== undefined ? { exemptFiles } : {}),
  });

  return { classification, dirtySourcePaths };
}

interface FilterFormattingDebtOptions {
  cwd: string;
  git?: PhaseHandlerContext['git'] | undefined;
  manifest?: TaskManifest | undefined;
  currentTaskNumber: number;
  completedTaskNumbers: ReadonlySet<number>;
  preStepHead?: string | undefined;
  postStepHead?: string | undefined;
  modifiedReferenceFiles: string[];
  driftFiles: string[];
  prematureImplementation: PrematureImplementationRecord[];
  nonGoalFiles: string[];
  protectedFiles: string[];
  emit: EventEmitter;
  totalSteps: number;
}

interface FilterFormattingDebtResult {
  modifiedReferenceFiles: string[];
  driftFiles: string[];
  prematureImplementation: PrematureImplementationRecord[];
  nonGoalFiles: string[];
  protectedFiles: string[];
  inheritedFormattingDebtFiles: string[];
}

async function filterInheritedFormattingDebt({
  cwd,
  git,
  manifest,
  currentTaskNumber,
  completedTaskNumbers,
  preStepHead,
  postStepHead,
  modifiedReferenceFiles,
  driftFiles,
  prematureImplementation,
  nonGoalFiles,
  protectedFiles,
  emit,
  totalSteps,
}: FilterFormattingDebtOptions): Promise<FilterFormattingDebtResult> {
  const candidateFilesForDebt = [
    ...new Set([
      ...modifiedReferenceFiles,
      ...driftFiles,
      ...prematureImplementation.map((p) => p.path),
      ...nonGoalFiles,
      ...protectedFiles,
    ]),
  ].filter((path) => !isProtectedFilePath(path));

  const inheritedFormattingDebtFiles =
    manifest && git?.fileContent && preStepHead && postStepHead
      ? await findInheritedFormattingDebtFiles({
          cwd,
          manifest,
          currentTaskNumber,
          completedTaskNumbers,
          candidateFiles: candidateFilesForDebt,
          preStepHead,
          postStepHead,
          git,
        })
      : [];

  const inheritedSet = new Set(inheritedFormattingDebtFiles);
  const filteredModifiedReferenceFiles = modifiedReferenceFiles.filter(
    (path) => !inheritedSet.has(path),
  );
  const filteredDriftFiles = driftFiles.filter((path) => !inheritedSet.has(path));
  const filteredPrematureImplementation = prematureImplementation.filter(
    (p) => !inheritedSet.has(p.path),
  );
  const filteredNonGoalFiles = nonGoalFiles.filter((path) => !inheritedSet.has(path));
  const filteredProtectedFiles = protectedFiles.filter((path) => !inheritedSet.has(path));

  if (inheritedFormattingDebtFiles.length > 0) {
    emit(
      'step.inherited_formatting_debt',
      'info',
      `step ${currentTaskNumber}/${totalSteps} exempted inherited formatting debt: ${inheritedFormattingDebtFiles.join(', ')}`,
      {
        index: currentTaskNumber,
        total: totalSteps,
        preStepHead,
        postStepHead,
        files: inheritedFormattingDebtFiles,
      },
    );
  }

  return {
    modifiedReferenceFiles: filteredModifiedReferenceFiles,
    driftFiles: filteredDriftFiles,
    prematureImplementation: filteredPrematureImplementation,
    nonGoalFiles: filteredNonGoalFiles,
    protectedFiles: filteredProtectedFiles,
    inheritedFormattingDebtFiles,
  };
}

export interface OversizedTask {
  taskNum: number;
  taskTitle: string;
  file: string;
  lineCount: number;
  testCaseCount: number;
}

export interface LintTaskSizeResult {
  ok: boolean;
  oversized: OversizedTask[];
}

export interface StepRunContext {
  stepIndex: number;
  stepTitle: string;
  cwd: string;
  ctx: PhaseHandlerContext;
  manifest: TaskManifest;
  planMd: string;
  missingFiles?: string[];
  /**
   * Declared expected_files that remained uncommitted after the previous
   * outer ImplementHandler attempt.
   */
  priorAttemptMissingFiles?: string[];
  priorAttemptUndeclaredFiles?: string[];
  priorAttemptModifiedReferenceFiles?: string[];
  priorAttemptRepairedScopeFiles?: string[];
  priorAttemptRepairedProtectedFiles?: string[];
  initialPreStepHead?: string;
  exemptUndeclaredFiles?: string[];
  completedStepIndexes?: number[];
}

export interface StepRunResult {
  outcome: 'success' | 'failed' | 'needs_human_review' | 'recoverable_scope_violation';
  failureMessage?: string;
  failureKind?: FailureKind;
  modifiedReferenceFiles?: string[];
  prematureImplementation?: PrematureImplementationRecord[];
  driftFiles?: string[];
  nonGoalFiles?: string[];
  protectedFiles?: string[];
}

export interface ImplementHandlerOpts {
  steps: StepRepositoryPort;
  runStep: (sctx: StepRunContext) => Promise<StepRunResult>;
  setup?: (cwd: string) => Promise<{ ok: boolean; error?: string }>;
  lintTaskSize?: (cwd: string, manifest: TaskManifest) => Promise<LintTaskSizeResult>;
  validationPort?: ValidationPort;
  runWorkspaceTypecheck?: RunWorkspaceTypecheckPort;
  typecheckLogDir?: string | ((runUuid: string) => string);
  maxDeclaredFilesRetries?: number | undefined;
  exemptUndeclaredFiles?: string[] | undefined;
  revertScopeFiles?: RevertScopeFilesPort | undefined;
  deleteWorktreeFile?: DeleteWorktreeFilePort | undefined;
}

export class ImplementHandler implements PhaseHandler {
  readonly phase = PhaseName('implement');

  constructor(private readonly opts: ImplementHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('implement.started', 'info', 'implement started');

    const inboundDirty = await this.checkInboundWorktreeCleanliness(ctx, emit);
    if (inboundDirty !== undefined) {
      return inboundDirty;
    }

    const planMd = await this.readPlan(ctx, emit);
    if (typeof planMd !== 'string') return planMd;

    let manifestJson: string | undefined;
    try {
      manifestJson = await ctx.artifacts.read(ctx.runUuid, 'task-manifest.json');
    } catch (e) {
      if (e instanceof ArtifactNotFoundError) {
        manifestJson = undefined;
      } else {
        const message = `Failed to read task-manifest.json: ${e instanceof Error ? e.message : String(e)}`;
        return this.fail(ctx, emit, 'unknown', message);
      }
    }

    const validation = validatePlanTaskList(planMd, manifestJson, ctx, 'implement');
    if (!validation.success) {
      return this.fail(ctx, emit, 'invalid_result', validation.error);
    }
    let manifest = validation.manifest;

    const derived = derivePlanTasks(planMd, manifest);
    if (derived.length === 0) {
      return this.fail(
        ctx,
        emit,
        'invalid_result',
        manifest ? 'plan.md has no manifest steps' : 'plan.md has no "## Task" steps',
      );
    }

    for (const d of derived) {
      const task = manifest?.tasks.find((t) => t.n === d.index);
      const bodyResult = extractTaskBody(planMd, {
        taskNumber: d.index,
        ...(task?.title !== undefined ? { title: task.title } : {}),
      });
      if (!bodyResult.ok) {
        return this.fail(
          ctx,
          emit,
          'invalid_result',
          `Task ${d.index} has no acceptable heading in plan.md`,
        );
      }
    }

    const manifestPresent = !!manifest;
    if (!manifest) {
      // Synthesize a V1 manifest if none exists so downstream logic is uniform
      const synthManifest: TaskManifest = {
        version: 1,
        task_count: derived.length,
        tasks: derived.map((d) => ({
          n: d.index,
          title: d.title.replace(/^Task \d+: /, ''),
        })),
      };
      manifest = synthManifest;
    }

    const existing = this.opts.steps.listForRun(ctx.runUuid as RunId);
    const doneIdx = new Set(
      existing
        .filter((s) => s.phaseId === 'implement' && s.status === 'success')
        .map((s) => s.index),
    );

    if (this.opts.lintTaskSize && manifestPresent) {
      let lintResult: LintTaskSizeResult;
      try {
        const filteredManifest: TaskManifest = {
          ...manifest,
          tasks: (manifest.tasks as TaskManifestEntry[]).filter((t) => !doneIdx.has(t.n)),
        } as TaskManifest;
        lintResult = await this.opts.lintTaskSize(ctx.cwd, filteredManifest);
        if (!lintResult) {
          lintResult = { ok: true, oversized: [] };
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const isPathTraversal = message.includes('Path traversal detected');
        const failureKind: FailureKind = isPathTraversal ? 'invalid_result' : 'unknown';
        return this.fail(ctx, emit, failureKind, `lintTaskSize crashed: ${message}`);
      }
      for (const task of lintResult.oversized) {
        emit(
          'task_size.oversized',
          'warn',
          `task ${task.taskNum} targets oversized test file: ${task.file}`,
          {
            taskNum: task.taskNum,
            taskTitle: task.taskTitle,
            file: task.file,
            lineCount: task.lineCount,
            testCaseCount: task.testCaseCount,
          },
        );
      }
      if (!lintResult.ok) {
        return this.fail(
          ctx,
          emit,
          'invalid_result',
          `task size linting blocked: ${lintResult.oversized.map((t) => `task ${t.taskNum} (${t.file})`).join(', ')} exceed thresholds`,
          'Split tasks targeting oversized test files in plan.md.',
        );
      }
    }

    if (this.opts.setup && derived.some((d) => !doneIdx.has(d.index))) {
      try {
        const result = await this.opts.setup(ctx.cwd);
        if (!result.ok) {
          return this.fail(ctx, emit, 'setup_failed', result.error ?? 'setup failed');
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return this.fail(ctx, emit, 'setup_failed', `setup crashed: ${message}`);
      }
    }

    const totalSteps = derived.length;

    let statusPromise: Promise<string> | undefined;
    const readStatus = (): Promise<string> => {
      statusPromise ??= ctx.git.status(ctx.cwd);
      return statusPromise;
    };

    for (const d of derived) {
      if (doneIdx.has(d.index)) {
        emit('step.skipped', 'info', `step ${d.index}/${totalSteps} already complete`, {
          index: d.index,
          total: totalSteps,
        });
        continue;
      }

      const existingStep =
        this.opts.steps.findByIndex(ctx.runUuid as RunId, this.phase, d.index) ??
        existing.find(
          (candidate) => candidate.phaseId === 'implement' && candidate.index === d.index,
        );

      const task = manifest?.tasks.find((t) => t.n === d.index);
      const declaredFiles = declaredTaskFiles(task);
      const shouldCaptureBaseline = hasDeclaredSurface(task, manifest?.version);

      const revertCounts: Record<string, number> = existingStep?.revertCounts
        ? { ...existingStep.revertCounts }
        : {};

      let preStepHead = existingStep?.initialPreStepHead;
      if (shouldCaptureBaseline && preStepHead === undefined) {
        try {
          if (!ctx.git?.headCommitSha) {
            throw new Error('ctx.git.headCommitSha is not available');
          }
          preStepHead = await ctx.git.headCommitSha(ctx.cwd);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const startedAt = ctx.now();
          const step: Step = {
            id: existingStep?.id ?? ctx.idFactory?.() ?? `${ctx.runUuid}:implement:${d.index}`,
            runId: ctx.runUuid,
            phaseId: this.phase,
            index: d.index,
            title: d.title,
            status: 'failed',
            startedAt,
            completedAt: ctx.now(),
            revertCounts,
          };
          emit('step.started', 'info', `step ${d.index}/${totalSteps}: ${d.title}`, {
            index: d.index,
            total: totalSteps,
          });
          this.opts.steps.upsert(step);
          emit(
            'step.uncommitted_files',
            'error',
            `step ${d.index}/${totalSteps} failed baseline read: ${message}`,
            {
              expectedFiles: declaredFiles,
              preStepHead: undefined,
              error: message,
            },
          );
          emit(
            'step.failed',
            'error',
            `step ${d.index}/${totalSteps} failed baseline read: ${message}`,
            {
              index: d.index,
              total: totalSteps,
            },
          );
          return this.fail(
            ctx,
            emit,
            'unknown',
            `step ${d.index} (${d.title}) failed baseline commit query: ${message}`,
          );
        }
      } else if (shouldCaptureBaseline && preStepHead !== undefined && existingStep) {
        try {
          const currentHead = await ctx.git.headCommitSha(ctx.cwd);
          const stillAncestor = await ctx.git.isAncestor(ctx.cwd, preStepHead, currentHead);
          if (!stillAncestor && currentHead !== preStepHead) {
            preStepHead = currentHead;
            this.opts.steps.upsert({
              ...existingStep,
              initialPreStepHead: preStepHead,
              title: d.title,
              revertCounts,
            });
          }
        } catch {
          // If we cannot verify ancestry, keep the persisted value rather than fail the run.
        }
      }

      const startedAt = ctx.now();
      const step: Step = {
        id: existingStep?.id ?? ctx.idFactory?.() ?? `${ctx.runUuid}:implement:${d.index}`,
        runId: ctx.runUuid,
        phaseId: this.phase,
        index: d.index,
        title: d.title,
        status: 'running',
        startedAt,
        ...(preStepHead !== undefined ? { initialPreStepHead: preStepHead } : {}),
        revertCounts,
      };
      this.opts.steps.upsert(step);
      emit('step.started', 'info', `step ${d.index}/${totalSteps}: ${d.title}`, {
        index: d.index,
        total: totalSteps,
      });

      const maxDeclaredFilesRetries = this.opts.maxDeclaredFilesRetries ?? 1;
      let declaredFilesRetryCount = 0;
      let priorAttemptMissingFiles: string[] | undefined;
      let priorAttemptUndeclaredFiles: string[] | undefined;
      let priorAttemptRepairedScopeFiles: string[] | undefined;
      let result: StepRunResult;

      while (true) {
        const latestPersisted = this.opts.steps.findByIndex(
          ctx.runUuid as RunId,
          this.phase,
          d.index,
        );
        if (latestPersisted?.revertCounts) {
          step.revertCounts = { ...latestPersisted.revertCounts };
        }
        statusPromise = undefined;
        try {
          result = await this.opts.runStep({
            stepIndex: d.index,
            stepTitle: d.title,
            cwd: ctx.cwd,
            ctx,
            manifest: manifest!,
            planMd,
            completedStepIndexes: [...doneIdx].sort((a, b) => a - b),
            ...(preStepHead !== undefined ? { initialPreStepHead: preStepHead } : {}),
            ...(this.opts.exemptUndeclaredFiles !== undefined
              ? { exemptUndeclaredFiles: this.opts.exemptUndeclaredFiles }
              : {}),
            ...(priorAttemptMissingFiles !== undefined ? { priorAttemptMissingFiles } : {}),
            ...(priorAttemptUndeclaredFiles !== undefined ? { priorAttemptUndeclaredFiles } : {}),
            ...(priorAttemptRepairedScopeFiles !== undefined
              ? {
                  priorAttemptRepairedScopeFiles,
                  priorAttemptRepairedProtectedFiles:
                    priorAttemptRepairedScopeFiles.filter(isProtectedFilePath),
                }
              : {}),
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
          emit('step.failed', 'error', `step ${d.index}/${totalSteps} crashed: ${message}`, {
            index: d.index,
            total: totalSteps,
          });
          return this.fail(
            ctx,
            emit,
            'command_failed',
            `step ${d.index} (${d.title}) crashed: ${message}`,
          );
        }

        if (result.outcome === 'success' || result.outcome === 'recoverable_scope_violation') {
          const currentScope = resolveEffectiveTaskScope(task);
          const expectedFiles = currentScope.requiredFiles;
          const referenceFiles = currentScope.referenceFiles;
          const writableSet = normalizedPathSet([
            ...currentScope.requiredFiles,
            ...currentScope.mayExtendFiles,
          ]);
          const referenceSet = normalizedPathSet(referenceFiles);
          const exemptSet = normalizedPathSet(this.opts.exemptUndeclaredFiles);

          try {
            const remediation = await remediateScratchFiles({
              cwd: ctx.cwd,
              runUuid: ctx.runUuid,
              status: await readStatus(),
              writableFiles: writableSet,
              referenceFiles: referenceSet,
              exemptFiles: exemptSet,
              artifacts: ctx.artifacts,
              deleteWorktreeFile: this.opts.deleteWorktreeFile ?? ctx.deleteWorktreeFile,
              emit,
              phase: 'implement',
              stepIndex: d.index,
              totalSteps,
              stepTitle: task?.title ?? d.title,
            });
            if (remediation.remediated) {
              statusPromise = undefined;
            }
          } catch {
            // Reporting is best-effort. Existing declared-file checks below still
            // decide whether an unavailable status snapshot must fail closed.
          }

          if (shouldCaptureBaseline) {
            let postStepHead: string | undefined;
            let committedFiles: string[] = [];
            let verificationError: string | undefined;

            try {
              if (!ctx.git?.headCommitSha || typeof ctx.git?.changedFiles !== 'function') {
                throw new Error('ctx.git.changedFiles is not available');
              }
              postStepHead = await ctx.git.headCommitSha(ctx.cwd);
              committedFiles = await ctx.git.changedFiles(ctx.cwd, preStepHead!, postStepHead);
            } catch (e) {
              verificationError = e instanceof Error ? e.message : String(e);
            }

            if (verificationError !== undefined) {
              this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
              emit(
                'step.uncommitted_files',
                'error',
                `step ${d.index}/${totalSteps} commit coverage query failed: ${verificationError}`,
                {
                  expectedFiles,
                  preStepHead,
                  postStepHead,
                  error: verificationError,
                },
              );
              emit(
                'step.failed',
                'error',
                `step ${d.index}/${totalSteps} commit coverage query failed`,
                {
                  index: d.index,
                  total: totalSteps,
                },
              );
              return this.fail(
                ctx,
                emit,
                'unknown',
                `step ${d.index} (${d.title}) commit coverage query failed: ${verificationError}`,
              );
            }

            const initialCommittedNormalized = committedFiles
              .map(normalizeTaskPath)
              .filter(Boolean);
            const initialCommittedSet = new Set(initialCommittedNormalized);
            const requiredSet = normalizedPathSet(expectedFiles);
            const preservedModifiedReferenceFiles = referenceFiles.filter(
              (p) =>
                !requiredSet.has(normalizeTaskPath(p)) &&
                initialCommittedSet.has(normalizeTaskPath(p)),
            );

            let statusFailedBeforeAutoCommit = false;
            try {
              await readStatus();
            } catch (error) {
              statusFailedBeforeAutoCommit = true;
              verificationError = `git status failed before auto-commit: ${
                error instanceof Error ? error.message : String(error)
              }`;
            }

            if (!statusFailedBeforeAutoCommit) {
              const { classification: preCommitClassification, dirtySourcePaths } =
                await evaluateWorktreeState({
                  cwd: ctx.cwd,
                  git: ctx.git,
                  preStepHead,
                  postStepHead,
                  committedFiles,
                  readStatus,
                  currentScope,
                  manifest,
                  currentTaskNumber: d.index,
                  exemptFiles: this.opts.exemptUndeclaredFiles,
                });

              const permittedSet = new Set(preCommitClassification.permittedPaths);
              const dirtyApprovedPaths = [
                ...new Set(dirtySourcePaths.filter((p) => permittedSet.has(p))),
              ].sort();

              const preCommitCommittedSet = new Set(
                committedFiles.map(normalizeTaskPath).filter(Boolean),
              );
              const missingRequired = expectedFiles.filter(
                (p) => !preCommitCommittedSet.has(normalizeTaskPath(p)),
              );
              const dirtySourcePathSet = new Set(dirtySourcePaths);
              const allMissingRequiredAreDirty =
                missingRequired.length === 0 ||
                missingRequired.every((p) => dirtySourcePathSet.has(normalizeTaskPath(p)));

              if (dirtyApprovedPaths.length > 0 && allMissingRequiredAreDirty) {
                try {
                  await ctx.git.add(ctx.cwd, dirtyApprovedPaths);
                  await ctx.git.commit(ctx.cwd, task?.title ?? d.title, dirtyApprovedPaths);
                  postStepHead = await ctx.git.headCommitSha(ctx.cwd);
                  committedFiles = await ctx.git.changedFiles(ctx.cwd, preStepHead!, postStepHead);
                  statusPromise = undefined;
                  verificationError = undefined;
                } catch (error) {
                  verificationError = `declared-file auto-commit failed: ${
                    error instanceof Error ? error.message : String(error)
                  }`;
                }
              }
            }

            const postCommitEval = await evaluateWorktreeState({
              cwd: ctx.cwd,
              git: ctx.git,
              preStepHead,
              postStepHead,
              committedFiles,
              readStatus,
              currentScope,
              manifest,
              currentTaskNumber: d.index,
              exemptFiles: this.opts.exemptUndeclaredFiles,
            });
            let freshClassification = postCommitEval.classification;

            let modifiedReferenceFiles = freshClassification.modifiedReferenceFiles;
            let nonGoalFiles = freshClassification.nonGoalFiles;
            let prematureImplementation = freshClassification.prematureImplementation;
            let driftFiles = freshClassification.driftFiles;
            let protectedFiles = freshClassification.protectedFiles ?? [];

            if (preservedModifiedReferenceFiles.length > 0) {
              modifiedReferenceFiles = [
                ...new Set([...modifiedReferenceFiles, ...preservedModifiedReferenceFiles]),
              ].sort();
              const refSet = new Set(modifiedReferenceFiles);
              protectedFiles = protectedFiles.filter((p) => !refSet.has(p));
              driftFiles = driftFiles.filter((p) => !refSet.has(p));
              nonGoalFiles = nonGoalFiles.filter((p) => !refSet.has(p));
            }

            const debtFiltered = await filterInheritedFormattingDebt({
              cwd: ctx.cwd,
              git: ctx.git,
              manifest,
              currentTaskNumber: d.index,
              completedTaskNumbers: doneIdx,
              preStepHead: preStepHead!,
              postStepHead: postStepHead!,
              modifiedReferenceFiles,
              driftFiles,
              prematureImplementation,
              nonGoalFiles,
              protectedFiles,
              emit,
              totalSteps,
            });

            modifiedReferenceFiles = debtFiltered.modifiedReferenceFiles;
            nonGoalFiles = debtFiltered.nonGoalFiles;
            prematureImplementation = debtFiltered.prematureImplementation;
            driftFiles = debtFiltered.driftFiles;
            protectedFiles = debtFiltered.protectedFiles;

            const hasManifestFault = modifiedReferenceFiles.length > 0;
            if (hasManifestFault) {
              const failureMessage = `step ${d.index} (${d.title}) modified reference_files ${modifiedReferenceFiles.join(', ')}. This is a manifest fault: expected_files must include these files.`;
              this.opts.steps.upsert({
                ...step,
                status: 'needs_human_review',
                completedAt: ctx.now(),
              });
              emit(
                'step.needs_human_review',
                'warn',
                `step ${d.index}/${totalSteps} needs human review: modified reference files (${modifiedReferenceFiles.join(', ')})`,
                {
                  index: d.index,
                  total: totalSteps,
                  taskTitle: task?.title ?? d.title,
                  modifiedReferenceFiles,
                  preStepHead,
                  postStepHead,
                },
              );
              const suggestedAction = `Update task-manifest.json to move ${modifiedReferenceFiles.join(', ')} from task ${d.index} reference_files to expected_files (a file cannot appear in both), or regenerate the manifest, then resume the run.`;
              return this.needsHumanReview(
                ctx,
                emit,
                'needs_human_review',
                failureMessage,
                suggestedAction,
                ['task-manifest.json'],
              );
            }

            const undeclaredProtectedPaths = protectedFiles
              .filter((p) => !requiredSet.has(p))
              .filter((p) => isProtectedFilePath(p));

            const repairCandidates = [
              ...new Set(
                [
                  ...driftFiles,
                  ...nonGoalFiles,
                  ...prematureImplementation.map((p) => p.path),
                  ...undeclaredProtectedPaths,
                ]
                  .map(normalizeTaskPath)
                  .filter(Boolean),
              ),
            ].sort();

            let repairedScopeRecord:
              | {
                  revertedScopeFiles: string[];
                  removedNewlyIgnoredFilesCount: number;
                }
              | undefined;

            if (repairCandidates.length > 0) {
              const exhaustedCandidates = repairCandidates.filter(
                (p) => (step.revertCounts[p] ?? 0) >= 2,
              );
              if (exhaustedCandidates.length > 0) {
                const failureMessage = `step ${d.index} (${d.title}) exceeded maximum scope revert attempts (2) for: ${exhaustedCandidates.join(', ')}`;
                this.opts.steps.upsert({
                  ...step,
                  status: 'needs_human_review',
                  completedAt: ctx.now(),
                });
                emit(
                  'step.needs_human_review',
                  'warn',
                  `step ${d.index}/${totalSteps} needs human review: exceeded maximum scope revert attempts for ${exhaustedCandidates.join(', ')}`,
                  {
                    index: d.index,
                    total: totalSteps,
                    taskTitle: task?.title ?? d.title,
                    exhaustedCandidates,
                    preStepHead,
                    postStepHead,
                  },
                );
                const suggestedAction = `Inspect the repeated scope violations (${exhaustedCandidates.join(', ')}) and update task-manifest.json or implementation scope before resuming.`;
                return this.needsHumanReview(
                  ctx,
                  emit,
                  'needs_human_review',
                  failureMessage,
                  suggestedAction,
                  ['task-manifest.json'],
                );
              }

              if (this.opts.revertScopeFiles) {
                let repairResult: RevertScopeFilesResult;
                try {
                  repairResult = await this.opts.revertScopeFiles({
                    cwd: ctx.cwd,
                    baseline: preStepHead!,
                    expectedHeadSha: postStepHead!,
                    rewriteSafety: 'unpublished',
                    scopeFiles: repairCandidates,
                  });
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
                  emit(
                    'step.failed',
                    'error',
                    `step ${d.index}/${totalSteps} scope repair failed: ${message}`,
                    { index: d.index, total: totalSteps },
                  );
                  return this.fail(
                    ctx,
                    emit,
                    'command_failed',
                    `step ${d.index} (${d.title}) scope repair failed: ${message}`,
                  );
                }

                postStepHead = repairResult.amendedHeadSha;
                statusPromise = undefined;
                committedFiles = await ctx.git.changedFiles(ctx.cwd, preStepHead!, postStepHead);

                const actuallyRevertedNormalized = new Set(
                  repairResult.revertedScopeFiles.map(normalizeTaskPath).filter(Boolean),
                );
                for (const normPath of actuallyRevertedNormalized) {
                  step.revertCounts[normPath] = (step.revertCounts[normPath] ?? 0) + 1;
                }
                this.opts.steps.upsert({ ...step, status: 'running' });

                repairedScopeRecord = {
                  revertedScopeFiles: repairResult.revertedScopeFiles,
                  removedNewlyIgnoredFilesCount: repairResult.removedNewlyIgnoredFiles.length,
                };

                const postRepairEval = await evaluateWorktreeState({
                  cwd: ctx.cwd,
                  git: ctx.git,
                  preStepHead,
                  postStepHead,
                  committedFiles,
                  readStatus,
                  currentScope,
                  manifest,
                  currentTaskNumber: d.index,
                  exemptFiles: this.opts.exemptUndeclaredFiles,
                });
                freshClassification = postRepairEval.classification;

                modifiedReferenceFiles = freshClassification.modifiedReferenceFiles;
                nonGoalFiles = freshClassification.nonGoalFiles;
                prematureImplementation = freshClassification.prematureImplementation;
                driftFiles = freshClassification.driftFiles;
                protectedFiles = freshClassification.protectedFiles ?? [];

                const postRepairDebtFiltered = await filterInheritedFormattingDebt({
                  cwd: ctx.cwd,
                  git: ctx.git,
                  manifest,
                  currentTaskNumber: d.index,
                  completedTaskNumbers: doneIdx,
                  preStepHead: preStepHead!,
                  postStepHead: postStepHead!,
                  modifiedReferenceFiles,
                  driftFiles,
                  prematureImplementation,
                  nonGoalFiles,
                  protectedFiles,
                  emit,
                  totalSteps,
                });

                modifiedReferenceFiles = postRepairDebtFiltered.modifiedReferenceFiles;
                nonGoalFiles = postRepairDebtFiltered.nonGoalFiles;
                prematureImplementation = postRepairDebtFiltered.prematureImplementation;
                driftFiles = postRepairDebtFiltered.driftFiles;
                protectedFiles = postRepairDebtFiltered.protectedFiles;
              } else if (repairCandidates.some(isProtectedFilePath)) {
                const repairError = 'revertScopeFiles port is not configured';
                this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
                emit(
                  'step.failed',
                  'error',
                  `step ${d.index}/${totalSteps} scope repair failed: ${repairError}`,
                  { index: d.index, total: totalSteps },
                );
                return this.fail(
                  ctx,
                  emit,
                  'command_failed',
                  `step ${d.index} (${d.title}) scope repair failed: ${repairError}`,
                );
              }
            }

            const committedNormalized = committedFiles.map(normalizeTaskPath).filter(Boolean);
            const committedSet = new Set(committedNormalized);
            const missingFiles = expectedFiles.filter(
              (path) => !committedSet.has(normalizeTaskPath(path)),
            );

            let verifiedUnaffected = false;
            if (missingFiles.length > 0) {
              let uncommittedDeclared: string[] = [];
              try {
                const status = await readStatus();
                const dirty = new Set(
                  uncommittedSourcePaths(status).map(normalizeTaskPath).filter(Boolean),
                );
                uncommittedDeclared = missingFiles.filter((f) => dirty.has(normalizeTaskPath(f)));
              } catch {
                uncommittedDeclared = missingFiles;
              }

              if (uncommittedDeclared.length > 0) {
                verificationError ??= `declared files written but not committed: ${uncommittedDeclared.join(', ')}`;
              } else if (this.opts.validationPort && this.opts.runWorkspaceTypecheck) {
                const validationCommands = buildTaskValidationCommands(manifest, d.index);
                let validationsPassed = true;

                if (validationCommands.length > 0) {
                  const logDir =
                    typeof this.opts.typecheckLogDir === 'function'
                      ? this.opts.typecheckLogDir(ctx.runUuid)
                      : (this.opts.typecheckLogDir ?? '/tmp');
                  const validationResult = await this.opts.validationPort.run({
                    cwd: ctx.cwd,
                    commands: validationCommands,
                    timeoutSeconds: 300,
                    logDir,
                  });
                  for (const cmdResult of validationResult) {
                    if (cmdResult.outcome !== 'passed') {
                      validationsPassed = false;
                      verificationError =
                        'validation failed: ' +
                        cmdResult.command +
                        '\n' +
                        (cmdResult.stderr || cmdResult.stdout);
                      break;
                    }
                  }
                } else {
                  validationsPassed = true;
                }

                if (validationsPassed) {
                  const typecheckResult = await this.opts.runWorkspaceTypecheck({ cwd: ctx.cwd });
                  if (typecheckResult.ok) {
                    verifiedUnaffected = true;
                  } else {
                    verificationError = typecheckResult.error;
                  }
                }
              }

              if (verifiedUnaffected) {
                emit(
                  'step.unaffected_files_verified',
                  'info',
                  `step ${d.index}/${totalSteps} verified missing files as unaffected: ${missingFiles.join(', ')}`,
                  { expectedFiles, committedFiles, missingFiles, preStepHead, postStepHead },
                );
              }
            }

            const blockingUndeclaredFiles = [
              ...new Set([
                ...driftFiles,
                ...nonGoalFiles,
                ...prematureImplementation.map((p) => p.path),
                ...protectedFiles,
              ]),
            ].sort();

            const hasMissingViolation = missingFiles.length > 0 && !verifiedUnaffected;
            const hasUndeclaredViolation = blockingUndeclaredFiles.length > 0;
            const hasScopeRepairViolation = repairedScopeRecord !== undefined;
            const hasBoundaryViolation =
              hasMissingViolation || hasUndeclaredViolation || hasScopeRepairViolation;

            if (hasBoundaryViolation) {
              if (declaredFilesRetryCount < maxDeclaredFilesRetries) {
                declaredFilesRetryCount += 1;
                priorAttemptMissingFiles = hasMissingViolation ? missingFiles : undefined;
                priorAttemptUndeclaredFiles =
                  blockingUndeclaredFiles.length > 0 ? blockingUndeclaredFiles : undefined;
                priorAttemptRepairedScopeFiles = repairedScopeRecord?.revertedScopeFiles;

                this.opts.steps.upsert({ ...step, status: 'running' });
                emit(
                  'step.declared_files_retry',
                  'warn',
                  `step ${d.index}/${totalSteps} violated task boundaries; retrying attempt ${declaredFilesRetryCount}/${maxDeclaredFilesRetries}`,
                  {
                    index: d.index,
                    attempt: declaredFilesRetryCount,
                    maxRetries: maxDeclaredFilesRetries,
                    taskTitle: task?.title ?? d.title,
                    expectedFiles,
                    referenceFiles,
                    exemptFiles: this.opts.exemptUndeclaredFiles ?? [],
                    committedFiles,
                    ...(hasMissingViolation ? { missingFiles } : {}),
                    modifiedReferenceFiles,
                    undeclaredFiles: blockingUndeclaredFiles,
                    ...(repairedScopeRecord !== undefined
                      ? {
                          repairedScopeFiles: repairedScopeRecord.revertedScopeFiles,
                          removedNewlyIgnoredFilesCount:
                            repairedScopeRecord.removedNewlyIgnoredFilesCount,
                          protectedFileDiagnostic: formatProtectedDiagnostic({
                            revertedProtectedFiles:
                              repairedScopeRecord.revertedScopeFiles.filter(isProtectedFilePath),
                            removedNewlyIgnoredFilesCount:
                              repairedScopeRecord.removedNewlyIgnoredFilesCount,
                          }),
                        }
                      : {}),
                    preStepHead,
                    postStepHead,
                    verificationError,
                  },
                );
                continue;
              } else {
                this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
                if (hasMissingViolation) {
                  emit(
                    'step.uncommitted_files',
                    'error',
                    `step ${d.index}/${totalSteps} did not commit declared files: ${missingFiles.join(', ')}`,
                    {
                      expectedFiles,
                      committedFiles,
                      missingFiles,
                      preStepHead,
                      postStepHead,
                      verificationError,
                    },
                  );
                }

                const violationParts: string[] = [];
                if (repairedScopeRecord !== undefined) {
                  const protectedReverted =
                    repairedScopeRecord.revertedScopeFiles.filter(isProtectedFilePath);
                  if (protectedReverted.length > 0) {
                    violationParts.push(
                      formatProtectedDiagnostic({
                        revertedProtectedFiles: protectedReverted,
                        removedNewlyIgnoredFilesCount:
                          repairedScopeRecord.removedNewlyIgnoredFilesCount,
                      }),
                    );
                  }
                }
                if (hasMissingViolation) {
                  violationParts.push(`did not commit declared files: ${missingFiles.join(', ')}`);
                }
                const nonProtectedRepaired = repairedScopeRecord
                  ? repairedScopeRecord.revertedScopeFiles.filter((p) => !isProtectedFilePath(p))
                  : [];
                const allUndeclaredFiles = [
                  ...new Set([...nonProtectedRepaired, ...blockingUndeclaredFiles]),
                ].sort();
                if (allUndeclaredFiles.length > 0) {
                  violationParts.push(
                    `committed undeclared files: ${allUndeclaredFiles.join(', ')}`,
                  );
                }

                const failureMessage = `step ${d.index} (${d.title}) ${violationParts.join('; ')}`;
                emit('step.failed', 'error', failureMessage, {
                  index: d.index,
                  total: totalSteps,
                });
                return this.fail(
                  ctx,
                  emit,
                  'invalid_result',
                  failureMessage,
                  hasMissingViolation && !hasUndeclaredViolation && !hasScopeRepairViolation
                    ? 'Ensure the implementation commits all files declared in expected_files.'
                    : 'Ensure the implementation commits all declared expected_files and does not modify reference or undeclared files.',
                );
              }
            }
          }

          if (result.outcome === 'success') {
            this.opts.steps.upsert({ ...step, status: 'success', completedAt: ctx.now() });
            doneIdx.add(d.index);
            emit('step.completed', 'info', `step ${d.index}/${totalSteps} done`, {
              index: d.index,
              total: totalSteps,
            });
          } else {
            const failureMessage =
              result.failureMessage ??
              `step ${d.index} (${d.title}) scope violation could not be recovered`;
            this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
            emit('step.failed', 'error', failureMessage, {
              index: d.index,
              total: totalSteps,
            });
            return this.fail(ctx, emit, result.failureKind ?? 'invalid_result', failureMessage);
          }
        } else if (result.outcome === 'needs_human_review') {
          this.opts.steps.upsert({ ...step, status: 'needs_human_review', completedAt: ctx.now() });
          emit(
            'step.needs_human_review',
            'warn',
            result.failureMessage ?? `step ${d.index}/${totalSteps} needs human review`,
            {
              index: d.index,
              total: totalSteps,
              taskTitle: task?.title ?? d.title,
              ...(result.modifiedReferenceFiles !== undefined
                ? { modifiedReferenceFiles: result.modifiedReferenceFiles }
                : {}),
              ...(preStepHead !== undefined ? { preStepHead } : {}),
            },
          );
          const isManifestFault =
            result.modifiedReferenceFiles && result.modifiedReferenceFiles.length > 0;
          const suggestedAction = isManifestFault
            ? `Update task-manifest.json to move ${result.modifiedReferenceFiles!.join(', ')} from task ${d.index} reference_files to expected_files (a file cannot appear in both), or regenerate the manifest, then resume the run.`
            : undefined;
          const artifacts = isManifestFault ? ['task-manifest.json'] : [];
          return this.needsHumanReview(
            ctx,
            emit,
            result.failureKind ?? 'agent_incomplete',
            result.failureMessage ?? `step ${d.index} (${d.title}) needs human review`,
            suggestedAction,
            artifacts,
          );
        } else {
          this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
          if (result.failureMessage) {
            emit('step.failed', 'error', result.failureMessage, {
              index: d.index,
              total: totalSteps,
            });
            return this.fail(
              ctx,
              emit,
              result.failureKind ?? 'invalid_result',
              result.failureMessage,
            );
          }
          emit('step.failed', 'error', `step ${d.index}/${totalSteps} failed`, {
            index: d.index,
            total: totalSteps,
          });
          return this.fail(
            ctx,
            emit,
            result.failureKind ?? 'agent_incomplete',
            `step ${d.index} (${d.title}) failed`,
          );
        }
        break;
      }
    }

    // Phase-boundary worktree reconciliation
    try {
      const statusOutput = await ctx.git.status(ctx.cwd);
      const dirtyPaths = uncommittedSourcePaths(statusOutput);
      if (dirtyPaths.length > 0) {
        const exemptSet = normalizedPathSet(this.opts.exemptUndeclaredFiles);
        const classification = await classifyPhaseBoundaryDirtyPaths({
          cwd: ctx.cwd,
          dirtyPaths,
          exemptSet,
          git: ctx.git,
          readWorktreeFile: ctx.readWorktreeFile,
        });

        if (classification.unpermitted.length > 0) {
          emit(
            'implement.needs_human_review',
            'warn',
            `implement phase boundary: uncommitted substantive files need attention: ${classification.unpermitted.join(', ')}`,
          );
          return this.needsHumanReview(
            ctx,
            emit,
            'agent_incomplete',
            `implement phase has uncommitted non-formatting, non-exempt files: ${classification.unpermitted.join(', ')}. Commit or revert these files before resuming.`,
            `Commit the listed files or revert them, then resume the run.`,
            classification.unpermitted,
          );
        }

        if (classification.permitted.length > 0) {
          // Auto-commit permitted formatting debt and exempt files
          try {
            let permittedAtActionTime = classification.permitted;
            try {
              const recheckStatusOutput = await ctx.git.status(ctx.cwd);
              const stillDirty = new Set(
                uncommittedSourcePaths(recheckStatusOutput).map(normalizeTaskPath).filter(Boolean),
              );
              permittedAtActionTime = classification.permitted.filter((p) => {
                const norm = normalizeTaskPath(p);
                return norm && stillDirty.has(norm);
              });
            } catch {
              // If re-check fails, fall back to the originally-classified list.
              permittedAtActionTime = classification.permitted;
            }

            if (permittedAtActionTime.length > 0) {
              await ctx.git.add(ctx.cwd, permittedAtActionTime);
              const statusAfterAdd = await ctx.git.status(ctx.cwd);
              const hasStaged = statusAfterAdd
                .split('\n')
                .some(
                  (line) =>
                    line.length >= 2 && line[0] !== ' ' && line[0] !== '?' && line[0] !== '!',
                );
              if (hasStaged) {
                await ctx.git.commit(
                  ctx.cwd,
                  'chore: auto-commit formatting debt and exempt files at implement phase boundary',
                );
                emit(
                  'implement.formatting_debt_auto_committed',
                  'info',
                  `auto-committed ${permittedAtActionTime.length} permitted file(s) at phase boundary`,
                  { files: permittedAtActionTime },
                );
              }
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return this.fail(ctx, emit, 'unknown', `phase-boundary auto-commit failed: ${msg}`);
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If we cannot determine cleanliness, fail rather than pass with dirty tree
      return this.fail(ctx, emit, 'unknown', `phase-boundary worktree check failed: ${msg}`);
    }

    emit('implement.completed', 'info', 'implement complete');
    return { outcome: 'passed' };
  }

  private async checkInboundWorktreeCleanliness(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
  ): Promise<PhaseResult | undefined> {
    if (ctx.priorPhaseName === undefined) {
      return undefined;
    }
    let statusOutput: string;
    try {
      statusOutput = await ctx.git.status(ctx.cwd);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.fail(
        ctx,
        emit,
        'unknown',
        `inbound worktree cleanliness check failed: ${message}`,
      );
    }
    const dirtyPaths = uncommittedSourcePaths(statusOutput);
    if (dirtyPaths.length === 0) {
      return undefined;
    }
    const fileList = formatDirtyPaths(dirtyPaths);
    const message = `${ctx.priorPhaseName} left the worktree dirty: ${fileList}. implement aborted to surface the boundary violation; resolve the dirty worktree in ${ctx.priorPhaseName} before re-running implement.`;
    emit('implement.phase_boundary_violation', 'error', message, {
      priorPhaseName: ctx.priorPhaseName,
      dirtyPaths,
    });
    return this.fail(ctx, emit, 'phase_boundary_violation', message);
  }

  private async readPlan(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
  ): Promise<string | PhaseResult> {
    try {
      return await ctx.artifacts.read(ctx.runUuid, 'plan.md');
    } catch (e) {
      const message =
        e instanceof ArtifactNotFoundError
          ? 'plan.md not found in artifact store'
          : `Failed to read plan.md: ${e instanceof Error ? e.message : String(e)}`;
      return this.fail(
        ctx,
        emit,
        e instanceof ArtifactNotFoundError ? 'missing_artifact' : 'unknown',
        message,
      );
    }
  }

  private fail(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    kind: FailureKind,
    message: string,
    suggestedAction?: string,
  ): PhaseResult {
    emit('implement.failed', 'error', message);
    return {
      outcome: 'failed',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'implement',
        kind,
        message,
        canRetry: kind !== 'invalid_result',
        suggestedAction:
          suggestedAction ??
          (kind === 'invalid_result'
            ? 'Ensure plan.md contains "## Task" headings.'
            : 'Inspect the failing step artifacts and resume.'),
        artifacts: [],
        detectedAt: ctx.now(),
      },
    };
  }

  private needsHumanReview(
    ctx: PhaseHandlerContext,
    emit: EventEmitter,
    kind: FailureKind,
    message: string,
    suggestedAction?: string,
    artifacts: string[] = [],
  ): PhaseResult {
    emit('implement.needs_human_review', 'warn', message);
    return {
      outcome: 'needs_human_review',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'implement',
        kind,
        message,
        canRetry: true,
        suggestedAction: suggestedAction ?? 'Review the step that needs attention and resume.',
        artifacts,
        detectedAt: ctx.now(),
      },
    };
  }
}
