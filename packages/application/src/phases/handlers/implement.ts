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
import { uncommittedSourcePaths, unquoteGitPath } from '../../artifacts/orchestrator-artifacts.js';

import {
  normalizeTaskPath,
  declaredTaskFiles,
  referenceTaskFiles,
  normalizedPathSet,
  hasDeclaredSurface,
  classifyUndeclaredFiles,
} from '../../task-file-boundaries.js';
import { findInheritedFormattingDebtFiles } from '../../inherited-formatting-debt.js';
import type {
  RevertProtectedFilesPort,
  RevertProtectedFilesResult,
} from '../../ports/protected-file-reverter-port.js';

function isProtectedFilePath(path: string): boolean {
  const norm = normalizeTaskPath(path);
  return norm === '.gitignore' || norm === '.ai-orchestrator.json' || norm.startsWith('.github/');
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

function undeclaredUntrackedRootFiles(
  status: string,
  writableFiles: ReadonlySet<string>,
  referenceFiles: ReadonlySet<string>,
  exemptFiles: ReadonlySet<string>,
): string[] {
  const paths = status
    .split('\n')
    .filter((line) => line.startsWith('?? '))
    .map((line) => normalizeTaskPath(unquoteGitPath(line.slice(3))))
    .filter((path) => path.length > 0 && !path.includes('/'))
    .filter(
      (path) => !writableFiles.has(path) && !referenceFiles.has(path) && !exemptFiles.has(path),
    );

  return [...new Set(paths)].sort();
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
  priorAttemptRepairedProtectedFiles?: string[];
  initialPreStepHead?: string;
  exemptUndeclaredFiles?: string[];
  completedStepIndexes?: number[];
}

export interface StepRunResult {
  outcome: 'success' | 'failed' | 'needs_human_review';
  failureMessage?: string;
  failureKind?: FailureKind;
  modifiedReferenceFiles?: string[];
}

export interface ImplementHandlerOpts {
  steps: StepRepositoryPort;
  runStep: (sctx: StepRunContext) => Promise<StepRunResult>;
  setup?: (cwd: string) => Promise<{ ok: boolean; error?: string }>;
  lintTaskSize?: (cwd: string, manifest: TaskManifest) => Promise<LintTaskSizeResult>;
  validationPort?: ValidationPort;
  runWorkspaceTypecheck?: RunWorkspaceTypecheckPort;
  typecheckLogDir?: string | ((runUuid: string) => string);
  maxDeclaredFilesRetries?: number;
  exemptUndeclaredFiles?: string[];
  revertProtectedFiles?: RevertProtectedFilesPort;
}

export class ImplementHandler implements PhaseHandler {
  readonly phase = PhaseName('implement');

  constructor(private readonly opts: ImplementHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('implement.started', 'info', 'implement started');

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

    for (const d of derived) {
      if (doneIdx.has(d.index)) {
        emit('step.skipped', 'info', `step ${d.index}/${totalSteps} already complete`, {
          index: d.index,
          total: totalSteps,
        });
        continue;
      }

      const existingStep = existing.find(
        (candidate) => candidate.phaseId === 'implement' && candidate.index === d.index,
      );

      const task = manifest?.tasks.find((t) => t.n === d.index);
      const declaredFiles = declaredTaskFiles(task);
      const shouldCaptureBaseline = hasDeclaredSurface(task, manifest?.version);

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
      let priorAttemptRepairedProtectedFiles: string[] | undefined;
      let result: StepRunResult;

      while (true) {
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
            ...(priorAttemptRepairedProtectedFiles !== undefined
              ? { priorAttemptRepairedProtectedFiles }
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

        if (result.outcome === 'success') {
          const expectedFiles = declaredFiles;
          const referenceFiles = referenceTaskFiles(task);
          const writableSet = normalizedPathSet(expectedFiles);
          const referenceSet = normalizedPathSet(referenceFiles);
          const exemptSet = normalizedPathSet(this.opts.exemptUndeclaredFiles);
          let statusPromise: Promise<string> | undefined;
          const readStatus = (): Promise<string> => {
            statusPromise ??= ctx.git.status(ctx.cwd);
            return statusPromise;
          };

          try {
            const scratchFiles = undeclaredUntrackedRootFiles(
              await readStatus(),
              writableSet,
              referenceSet,
              exemptSet,
            );
            if (scratchFiles.length > 0) {
              emit(
                'step.scratch_files_left',
                'warn',
                `step ${d.index}/${totalSteps} left undeclared root files: ${scratchFiles.join(', ')}`,
                {
                  index: d.index,
                  total: totalSteps,
                  taskTitle: task?.title ?? d.title,
                  files: scratchFiles,
                },
              );
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

            let committedNormalized = committedFiles.map(normalizeTaskPath).filter(Boolean);
            let committedSet = new Set(committedNormalized);
            let missingFiles = expectedFiles.filter((p) => !committedSet.has(normalizeTaskPath(p)));

            if (missingFiles.length > 0) {
              let statusProvedAllMissingDirty = false;
              let uncommittedDeclared: string[] = [];

              try {
                const status = await readStatus();
                const dirty = new Set(
                  uncommittedSourcePaths(status).map(normalizeTaskPath).filter(Boolean),
                );
                uncommittedDeclared = missingFiles.filter((file) =>
                  dirty.has(normalizeTaskPath(file)),
                );
                statusProvedAllMissingDirty =
                  missingFiles.length > 0 && uncommittedDeclared.length === missingFiles.length;
              } catch (error) {
                verificationError = `git status failed before auto-commit: ${
                  error instanceof Error ? error.message : String(error)
                }`;
              }

              if (statusProvedAllMissingDirty) {
                try {
                  await ctx.git.add(ctx.cwd, uncommittedDeclared);
                  await ctx.git.commit(ctx.cwd, task?.title ?? d.title, uncommittedDeclared);
                  postStepHead = await ctx.git.headCommitSha(ctx.cwd);
                  committedFiles = await ctx.git.changedFiles(ctx.cwd, preStepHead!, postStepHead);
                  committedNormalized = committedFiles.map(normalizeTaskPath).filter(Boolean);
                  committedSet = new Set(committedNormalized);
                  missingFiles = expectedFiles.filter(
                    (path) => !committedSet.has(normalizeTaskPath(path)),
                  );
                  verificationError = undefined;
                } catch (error) {
                  verificationError = `declared-file auto-commit failed: ${
                    error instanceof Error ? error.message : String(error)
                  }`;
                }
              }
            }

            const initialClassification = classifyUndeclaredFiles(
              committedFiles,
              writableSet,
              referenceSet,
              exemptSet,
            );
            const preservedModifiedReferenceFiles = initialClassification.modifiedReferenceFiles;

            const undeclaredProtectedPaths = [
              ...new Set(
                committedFiles
                  .map(normalizeTaskPath)
                  .filter((p) => p.length > 0 && isProtectedFilePath(p) && !writableSet.has(p)),
              ),
            ].sort();

            let repairedProtectedRecord:
              | { revertedProtectedFiles: string[]; removedNewlyIgnoredFilesCount: number }
              | undefined;
            let protectedRepairError: string | undefined;

            if (undeclaredProtectedPaths.length > 0) {
              if (this.opts.revertProtectedFiles) {
                let repairResult: RevertProtectedFilesResult;
                try {
                  repairResult = await this.opts.revertProtectedFiles({
                    cwd: ctx.cwd,
                    baseline: preStepHead!,
                    protectedFiles: undeclaredProtectedPaths,
                  });
                  statusPromise = undefined;
                  postStepHead = await ctx.git.headCommitSha(ctx.cwd);
                  committedFiles = await ctx.git.changedFiles(ctx.cwd, preStepHead!, postStepHead);
                  committedNormalized = committedFiles.map(normalizeTaskPath).filter(Boolean);
                  committedSet = new Set(committedNormalized);
                  missingFiles = expectedFiles.filter(
                    (path) => !committedSet.has(normalizeTaskPath(path)),
                  );
                  repairedProtectedRecord = {
                    revertedProtectedFiles: repairResult.revertedProtectedFiles,
                    removedNewlyIgnoredFilesCount: repairResult.removedNewlyIgnoredFiles.length,
                  };
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  if (preservedModifiedReferenceFiles.length === 0) {
                    this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
                    emit(
                      'step.failed',
                      'error',
                      `step ${d.index}/${totalSteps} protected file repair failed: ${message}`,
                      { index: d.index, total: totalSteps },
                    );
                    return this.fail(
                      ctx,
                      emit,
                      'command_failed',
                      `step ${d.index} (${d.title}) protected file repair failed: ${message}`,
                    );
                  }
                  protectedRepairError = message;
                }
              } else if (preservedModifiedReferenceFiles.length === 0) {
                const repairError = 'revertProtectedFiles port is not configured';
                this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
                emit(
                  'step.failed',
                  'error',
                  `step ${d.index}/${totalSteps} protected file repair failed: ${repairError}`,
                  { index: d.index, total: totalSteps },
                );
                return this.fail(
                  ctx,
                  emit,
                  'command_failed',
                  `step ${d.index} (${d.title}) protected file repair failed: ${repairError}`,
                );
              }
            }

            let { undeclaredFiles } = classifyUndeclaredFiles(
              committedFiles,
              writableSet,
              referenceSet,
              exemptSet,
            );
            let modifiedReferenceFiles = preservedModifiedReferenceFiles;

            const inheritedFormattingDebtFiles = await findInheritedFormattingDebtFiles({
              cwd: ctx.cwd,
              manifest,
              currentTaskNumber: d.index,
              completedTaskNumbers: doneIdx,
              candidateFiles: [...new Set([...modifiedReferenceFiles, ...undeclaredFiles])].filter(
                (path) => !isProtectedFilePath(path),
              ),
              preStepHead: preStepHead!,
              postStepHead: postStepHead!,
              git: ctx.git,
            });

            const inheritedSet = new Set(inheritedFormattingDebtFiles);
            modifiedReferenceFiles = modifiedReferenceFiles.filter(
              (path) => !inheritedSet.has(path),
            );
            undeclaredFiles = undeclaredFiles.filter((path) => !inheritedSet.has(path));

            if (inheritedFormattingDebtFiles.length > 0) {
              emit(
                'step.inherited_formatting_debt',
                'info',
                `step ${d.index}/${totalSteps} exempted inherited formatting debt: ${inheritedFormattingDebtFiles.join(', ')}`,
                {
                  index: d.index,
                  total: totalSteps,
                  preStepHead,
                  postStepHead,
                  files: inheritedFormattingDebtFiles,
                },
              );
            }

            const hasManifestFault = modifiedReferenceFiles.length > 0;
            if (hasManifestFault) {
              const failureMessage = protectedRepairError
                ? `step ${d.index} (${d.title}) modified reference_files ${modifiedReferenceFiles.join(', ')} and protected file repair failed: ${protectedRepairError}. This is a manifest fault: expected_files must include these files.`
                : `step ${d.index} (${d.title}) modified reference_files ${modifiedReferenceFiles.join(', ')}. This is a manifest fault: expected_files must include these files.`;
              this.opts.steps.upsert({
                ...step,
                status: 'needs_human_review',
                completedAt: ctx.now(),
              });
              emit(
                'step.needs_human_review',
                'warn',
                protectedRepairError
                  ? `step ${d.index}/${totalSteps} needs human review: modified reference files (${modifiedReferenceFiles.join(', ')}); protected file repair failed: ${protectedRepairError}`
                  : `step ${d.index}/${totalSteps} needs human review: modified reference files (${modifiedReferenceFiles.join(', ')})`,
                {
                  index: d.index,
                  total: totalSteps,
                  taskTitle: task?.title ?? d.title,
                  modifiedReferenceFiles,
                  ...(protectedRepairError ? { protectedRepairError } : {}),
                  preStepHead,
                  postStepHead,
                },
              );
              const suggestedAction = protectedRepairError
                ? `Repair the protected path changes (${undeclaredProtectedPaths.join(', ')}) and update task-manifest.json to add ${modifiedReferenceFiles.join(', ')} to task ${d.index} expected_files (or regenerate the manifest), then resume the run.`
                : `Update task-manifest.json to add ${modifiedReferenceFiles.join(', ')} to task ${d.index} expected_files (or regenerate the manifest), then resume the run.`;
              return this.needsHumanReview(
                ctx,
                emit,
                'needs_human_review',
                failureMessage,
                suggestedAction,
                ['task-manifest.json'],
              );
            }

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

            const hasMissingViolation = missingFiles.length > 0 && !verifiedUnaffected;
            const hasUndeclaredViolation = undeclaredFiles.length > 0;
            const hasProtectedViolation = repairedProtectedRecord !== undefined;
            const hasBoundaryViolation =
              hasMissingViolation || hasUndeclaredViolation || hasProtectedViolation;

            if (hasBoundaryViolation) {
              if (declaredFilesRetryCount < maxDeclaredFilesRetries) {
                declaredFilesRetryCount += 1;
                priorAttemptMissingFiles = hasMissingViolation ? missingFiles : undefined;
                priorAttemptUndeclaredFiles =
                  undeclaredFiles.length > 0 ? undeclaredFiles : undefined;
                priorAttemptRepairedProtectedFiles =
                  repairedProtectedRecord?.revertedProtectedFiles;

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
                    undeclaredFiles,
                    ...(repairedProtectedRecord !== undefined
                      ? {
                          repairedProtectedFiles: repairedProtectedRecord.revertedProtectedFiles,
                          removedNewlyIgnoredFilesCount:
                            repairedProtectedRecord.removedNewlyIgnoredFilesCount,
                          protectedFileDiagnostic:
                            formatProtectedDiagnostic(repairedProtectedRecord),
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
                if (repairedProtectedRecord !== undefined) {
                  violationParts.push(formatProtectedDiagnostic(repairedProtectedRecord));
                }
                if (hasMissingViolation) {
                  violationParts.push(`did not commit declared files: ${missingFiles.join(', ')}`);
                }
                if (undeclaredFiles.length > 0) {
                  violationParts.push(`committed undeclared files: ${undeclaredFiles.join(', ')}`);
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
                  hasMissingViolation && !hasUndeclaredViolation && !hasProtectedViolation
                    ? 'Ensure the implementation commits all files declared in expected_files.'
                    : 'Ensure the implementation commits all declared expected_files and does not modify reference or undeclared files.',
                );
              }
            }
          }

          this.opts.steps.upsert({ ...step, status: 'success', completedAt: ctx.now() });
          doneIdx.add(d.index);
          emit('step.completed', 'info', `step ${d.index}/${totalSteps} done`, {
            index: d.index,
            total: totalSteps,
          });
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
            ? `Update task-manifest.json to add ${result.modifiedReferenceFiles!.join(', ')} to task ${d.index} expected_files (or regenerate the manifest), then resume the run.`
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
              'invalid_result',
              result.failureMessage,
              'Separate the regression proof from its implementation task and resume from the failed step.',
            );
          }
          emit('step.failed', 'error', `step ${d.index}/${totalSteps} failed`, {
            index: d.index,
            total: totalSteps,
          });
          return this.fail(ctx, emit, 'agent_incomplete', `step ${d.index} (${d.title}) failed`);
        }
        break;
      }
    }

    emit('implement.completed', 'info', 'implement complete');
    return { outcome: 'passed' };
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
