import {
  createLoop,
  startIteration,
  completeIteration,
  canIterate,
  exhaust,
  type AgentProfileName,
} from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { RevalidationResult, FixStepOptions } from '../review-fix/types.js';
import {
  checkTaskBoundaries,
  classifyUndeclaredFiles,
  getManifestBoundaries,
  loadManifest,
  type ManifestLoadResult,
} from '../task-file-boundaries.js';
import { uncommittedSourcePaths } from '../artifacts/orchestrator-artifacts.js';
import type {
  ValidateFixLoopDeps,
  ValidateFixLoopInput,
  ValidateFixLoopResult,
  ValidateFixStepContext,
} from './types.js';

export class ValidateFixLoop {
  constructor(private readonly deps: ValidateFixLoopDeps) {}

  async execute(input: ValidateFixLoopInput): Promise<ValidateFixLoopResult> {
    const { deps } = this;
    let loop = createLoop({
      id: deps.idFactory(),
      runId: input.runId,
      phaseId: input.phaseId,
      type: 'validate-fix',
      maxIterations: input.maxIterations,
      now: deps.now(),
    });
    deps.loops.insert(loop);

    const manifestResult = await this.loadManifest(input, {
      cwd: input.cwd,
      runId: input.runId,
    });
    let allowedFiles: string[] | undefined;
    if (manifestResult.status === 'found') {
      const boundaries = getManifestBoundaries(manifestResult.manifest);
      if (boundaries.writableSet.size > 0) {
        allowedFiles = [...boundaries.writableSet].sort();
      }
    }

    let consecutiveFixFailures = 0;
    let nextDeterministicDiagnostic: string | undefined;

    while (canIterate(loop)) {
      const iterationIndex = loop.iterations.length + 1;
      const ctx: ValidateFixStepContext = {
        loopId: loop.id,
        runId: input.runId,
        phaseId: input.phaseId,
        repoId: input.repoId,
        cwd: input.cwd,
        iterationIndex,
      };

      this.emit(
        input,
        'loop.iteration.started',
        'info',
        `validate-fix iteration ${iterationIndex} started`,
        { index: iterationIndex },
      );

      // fix
      const useFallback = consecutiveFixFailures >= 2 && input.fixFallbackProfile !== undefined;
      if (useFallback) {
        this.emitEscalation(input, 'two_consecutive_fix_failures');
      }

      const fixOpts: FixStepOptions = {
        useFallback,
        ...(nextDeterministicDiagnostic
          ? { deterministicDiagnostic: nextDeterministicDiagnostic }
          : {}),
        ...(allowedFiles ? { allowedFiles } : {}),
      };
      nextDeterministicDiagnostic = undefined;

      const fix = await deps.runFix(ctx, fixOpts);
      loop = startIteration(loop, { reviewInvocationId: fix.invocationId, now: deps.now() });
      deps.loops.update(loop);

      if (fix.agentOutcome !== 'success') {
        if (fix.headBeforeFix && deps.rollbackFix) {
          await deps.rollbackFix(ctx, fix.headBeforeFix);
        }
        loop = completeIteration(loop, {
          outcome: 'failed',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        break;
      }

      let boundaryFailure: { files?: string[]; message: string } | undefined;
      if (deps.git && fix.headBeforeFix) {
        try {
          let committedFiles: string[] = [];
          const currentHead = await deps.git.headCommitSha(ctx.cwd);
          if (currentHead !== fix.headBeforeFix) {
            committedFiles = await deps.git.changedFiles(ctx.cwd, fix.headBeforeFix, currentHead);
          }

          let uncommittedFiles: string[] = [];
          const statusOutput = await deps.git.status(ctx.cwd);
          uncommittedFiles = uncommittedSourcePaths(statusOutput);

          const changedFiles = [...new Set([...committedFiles, ...uncommittedFiles])];

          if (changedFiles.length > 0) {
            if (manifestResult.status === 'missing') {
              const errorMsg = 'task-manifest.json not found';
              this.emit(
                input,
                'task_boundary.check_failed',
                'warn',
                `task boundary check failed: ${errorMsg}`,
                { iterationIndex, reason: 'missing_manifest', error: errorMsg },
              );
              boundaryFailure = { message: `task boundary check failed: ${errorMsg}` };
            } else if (manifestResult.status === 'malformed') {
              const errorMsg = manifestResult.message;
              this.emit(
                input,
                'task_boundary.check_failed',
                'warn',
                `task boundary check failed: ${errorMsg}`,
                { iterationIndex, reason: 'malformed_manifest', error: manifestResult.error },
              );
              boundaryFailure = { message: `task boundary check failed: ${errorMsg}` };
            } else {
              const scopeContractEnforcement = input.scopeContractEnforcement ?? true;
              let classification;

              if (scopeContractEnforcement) {
                classification = checkTaskBoundaries(changedFiles, manifestResult.manifest);
              } else {
                const { writableSet, referenceSet } = getManifestBoundaries(
                  manifestResult.manifest,
                );
                classification = classifyUndeclaredFiles(
                  changedFiles,
                  writableSet,
                  referenceSet,
                  new Set(),
                );
              }

              const violatingFiles = [
                ...classification.modifiedReferenceFiles,
                ...classification.undeclaredFiles,
              ];
              if (violatingFiles.length > 0) {
                const message = `${input.phaseId} modified undeclared files: ${violatingFiles.join(', ')}`;
                this.emit(input, 'task_boundary.violated', 'warn', message, {
                  phase: input.phaseId,
                  files: violatingFiles,
                  modifiedReferenceFiles: classification.modifiedReferenceFiles,
                  undeclaredFiles: classification.undeclaredFiles,
                  iterationIndex,
                });
                boundaryFailure = { files: violatingFiles, message };
              }
            }
          }
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.emit(
            input,
            'task_boundary.check_failed',
            'warn',
            `task boundary check failed: ${errorMsg}`,
            { iterationIndex, reason: 'check_error', error: errorMsg },
          );
          boundaryFailure = { message: `task boundary check failed: ${errorMsg}` };
        }
      }

      // If boundary failure occurred, surface as synthetic revalidation failure and rollback
      if (boundaryFailure) {
        const reval: RevalidationResult = {
          validationRunId: deps.idFactory(),
          passed: false,
          category: 'boundary',
          failureDetail: boundaryFailure.message,
        };

        if (fix.headBeforeFix && deps.rollbackFix) {
          const rollbackOk = await deps.rollbackFix(ctx, fix.headBeforeFix);
          if (!rollbackOk) {
            this.emit(
              input,
              'loop.rollback.failed',
              'error',
              `rollback failed on iteration ${iterationIndex}, breaking loop`,
              { index: iterationIndex },
            );
            loop = completeIteration(loop, {
              outcome: 'failed',
              fixInvocationId: fix.invocationId,
              now: deps.now(),
            });
            deps.loops.update(loop);
            this.emitIterationCompleted(input, iterationIndex, 'failed');
            break;
          }
        }

        const couldRollback = Boolean(fix.headBeforeFix && deps.rollbackFix);
        loop = completeIteration(loop, {
          outcome: 'revalidation_failed',
          fixInvocationId: fix.invocationId,
          revalidationId: reval.validationRunId,
          now: deps.now(),
        });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'revalidation_failed');

        if (!couldRollback) break;
        consecutiveFixFailures = 0;
        nextDeterministicDiagnostic = boundaryFailure.message;
        continue;
      }

      if (fix.verdict === 'no_fixes_needed') {
        const reval = await deps.runRevalidation(ctx);
        if (reval.passed) {
          loop = completeIteration(loop, {
            outcome: 'resolved',
            fixInvocationId: fix.invocationId,
            revalidationId: reval.validationRunId,
            now: deps.now(),
          });
          deps.loops.update(loop);
          this.emitIterationCompleted(input, iterationIndex, 'resolved');
          break;
        }
        loop = completeIteration(loop, {
          outcome: 'unresolved',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'unresolved');
        continue;
      }

      if (fix.verdict === undefined) {
        this.emit(
          input,
          'loop.verdict_missing',
          'warn',
          `fix agent returned undefined verdict on iteration ${iterationIndex}, breaking loop`,
          { index: iterationIndex, invocationId: fix.invocationId },
        );
        loop = completeIteration(loop, {
          outcome: 'failed',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        break;
      }

      if (fix.verdict === 'cannot_fix') {
        consecutiveFixFailures += 1;
        loop = completeIteration(loop, {
          outcome: 'fix_failed',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'fix_failed');
        continue;
      }
      consecutiveFixFailures = 0;

      const reval = await deps.runRevalidation(ctx);

      if (!reval.passed && !fix.headBeforeFix && deps.rollbackFix) {
        this.emit(
          input,
          'loop.rollback.unavailable',
          'error',
          `revalidation failed on iteration ${iterationIndex} but headBeforeFix not set — cannot roll back`,
          { index: iterationIndex },
        );
      }

      if (!reval.passed && fix.headBeforeFix && deps.rollbackFix) {
        const rollbackOk = await deps.rollbackFix(ctx, fix.headBeforeFix);
        if (!rollbackOk) {
          this.emit(
            input,
            'loop.rollback.failed',
            'error',
            `rollback failed on iteration ${iterationIndex}, breaking loop`,
            { index: iterationIndex },
          );
          loop = completeIteration(loop, {
            outcome: 'failed',
            fixInvocationId: fix.invocationId,
            now: deps.now(),
          });
          deps.loops.update(loop);
          this.emitIterationCompleted(input, iterationIndex, 'failed');
          break;
        }
      }

      const revalidationFailed = !reval.passed;
      const couldRollback = Boolean(fix.headBeforeFix && deps.rollbackFix);
      const iterOutcome = reval.passed ? 'resolved' : 'revalidation_failed';
      loop = completeIteration(loop, {
        outcome: iterOutcome,
        fixInvocationId: fix.invocationId,
        revalidationId: reval.validationRunId,
        now: deps.now(),
      });
      deps.loops.update(loop);
      this.emitIterationCompleted(input, iterationIndex, iterOutcome);

      if (reval.passed) break;
      // When revalidation fails and rollback was not possible, break to
      // prevent accumulating broken state across iterations.
      if (revalidationFailed && !couldRollback) break;
    }

    if (loop.status === 'converged') {
      return { loop, phaseOutcome: 'passed' };
    }
    if (loop.status === 'failed') {
      return { loop, phaseOutcome: 'failed' };
    }
    loop = exhaust(loop, this.deps.now());
    this.deps.loops.update(loop);
    this.emit(
      input,
      'loop.exhausted',
      'error',
      `validate-fix loop exhausted after ${loop.iterations.length} iterations`,
      {
        iterations: loop.iterations.length,
        maxIterations: loop.maxIterations,
      },
    );
    return { loop, phaseOutcome: 'failed' };
  }

  private emit(
    input: ValidateFixLoopInput,
    type: string,
    level: OrchestratorEvent['level'],
    message: string,
    metadata: Record<string, unknown>,
  ): void {
    this.deps.events.publish(input.runId as string, {
      runId: input.runId as string,
      phase: input.phaseId as string,
      level,
      type,
      message,
      timestamp: this.deps.now().toISOString(),
      metadata,
    });
  }

  private emitIterationCompleted(
    input: ValidateFixLoopInput,
    index: number,
    outcome: string,
  ): void {
    this.emit(
      input,
      'loop.iteration.completed',
      'info',
      `iteration ${index} completed: ${outcome}`,
      { index, outcome },
    );
  }

  private emitEscalation(input: ValidateFixLoopInput, triggerReason: string): void {
    if (input.fixFallbackProfile === undefined) return;
    const toProfile: AgentProfileName = input.fixFallbackProfile;
    this.emit(input, 'phase.fallback.escalated', 'warn', `escalating fix to ${toProfile}`, {
      fromProfile: input.fixProfile as string,
      toProfile: toProfile as string,
      triggerReason,
      triggerOwner: 'use_case',
    });
  }

  private async loadManifest(
    input: ValidateFixLoopInput,
    ctx: { cwd: string; runId?: unknown },
  ): Promise<ManifestLoadResult> {
    return loadManifest(input, ctx, this.deps);
  }
}
