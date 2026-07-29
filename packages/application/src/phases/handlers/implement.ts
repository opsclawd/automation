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

function normalizeTaskPath(path: unknown): string {
  if (typeof path !== 'string') return '';
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '');
}

function declaredTaskFiles(task: unknown): string[] {
  if (!task || typeof task !== 'object') return [];
  const record = task as Record<string, unknown>;
  const expectedFiles = Array.isArray(record.expected_files) ? record.expected_files : [];
  const files = Array.isArray(record.files) ? record.files : [];

  const requiredExpectedFiles = expectedFiles.map(normalizeTaskPath).filter(Boolean);
  const requiredLegacyFiles = files.map(normalizeTaskPath).filter(Boolean);
  return [...new Set([...requiredExpectedFiles, ...requiredLegacyFiles])];
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
}

export interface StepRunResult {
  outcome: 'success' | 'failed' | 'needs_human_review';
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

      let preStepHead = existingStep?.initialPreStepHead;
      if (declaredFiles.length > 0 && preStepHead === undefined) {
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

      let declaredFilesRetries = this.opts.maxDeclaredFilesRetries ?? 0;
      let declaredFilesRetryFailed = false;
      let missingFiles: string[] | undefined;
      let result: StepRunResult;

      do {
        declaredFilesRetryFailed = false;
        try {
          result = await this.opts.runStep({
            stepIndex: d.index,
            stepTitle: d.title,
            cwd: ctx.cwd,
            ctx,
            manifest: manifest!,
            planMd,
            ...(missingFiles !== undefined ? { missingFiles } : {}),
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
          const expectedFiles = declaredTaskFiles(task);
          if (expectedFiles.length > 0) {
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

            const committedSet = new Set(committedFiles.map((p) => p.replace(/\\/g, '/')));
            missingFiles = expectedFiles.filter((p) => !committedSet.has(p));

            if (missingFiles.length > 0) {
              let verifiedUnaffected = false;
              let verificationError: string | undefined;

              if (this.opts.validationPort && this.opts.runWorkspaceTypecheck) {
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
              } else {
                if (declaredFilesRetries > 0) {
                  declaredFilesRetries--;
                  declaredFilesRetryFailed = true;
                  this.opts.steps.upsert({ ...step, status: 'running' });
                  emit(
                    'step.uncommitted_files',
                    'warn',
                    `step ${d.index}/${totalSteps} did not commit declared files: ${missingFiles.join(', ')} — retrying`,
                    {
                      expectedFiles,
                      committedFiles,
                      missingFiles,
                      preStepHead,
                      postStepHead,
                      verificationError,
                    },
                  );
                  continue;
                }
                this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
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
                emit(
                  'step.failed',
                  'error',
                  `step ${d.index}/${totalSteps} did not commit declared files: ${missingFiles.join(', ')}`,
                  {
                    index: d.index,
                    total: totalSteps,
                  },
                );
                return this.fail(
                  ctx,
                  emit,
                  'invalid_result',
                  `step ${d.index} (${d.title}) did not commit declared files: ${missingFiles.join(', ')}`,
                  'Ensure the implementation commits all files declared in expected_files.',
                );
              }
            }
          }

          this.opts.steps.upsert({ ...step, status: 'success', completedAt: ctx.now() });
          emit('step.completed', 'info', `step ${d.index}/${totalSteps} done`, {
            index: d.index,
            total: totalSteps,
          });
        } else if (result.outcome === 'needs_human_review') {
          this.opts.steps.upsert({ ...step, status: 'needs_human_review', completedAt: ctx.now() });
          emit(
            'step.needs_human_review',
            'warn',
            `step ${d.index}/${totalSteps} needs human review`,
            {
              index: d.index,
              total: totalSteps,
            },
          );
          return this.needsHumanReview(
            ctx,
            emit,
            'agent_incomplete',
            `step ${d.index} (${d.title}) needs human review`,
          );
        } else {
          // No-op re-verification recovery (synthesizing a missing
          // implementation-log.md when the agent declared the step already
          // done) happens inside runStep/runImplement itself, before the
          // typecheck/spec-review/quality-review gates run — see #610. If
          // runStep still reports a non-success outcome here, the step
          // genuinely failed and there is nothing further to recover.
          this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
          emit('step.failed', 'error', `step ${d.index}/${totalSteps} failed`, {
            index: d.index,
            total: totalSteps,
          });
          return this.fail(ctx, emit, 'agent_incomplete', `step ${d.index} (${d.title}) failed`);
        }
      } while (declaredFilesRetryFailed);
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
        suggestedAction: 'Review the step that needs attention and resume.',
        artifacts: [],
        detectedAt: ctx.now(),
      },
    };
  }
}
