import {
  createLoop,
  startIteration,
  completeIteration,
  canIterate,
  exhaust,
  type AgentProfileName,
} from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { verifyFixCommit } from '../fix-commit-verifier.js';
import { commitIfDirty } from '../utils/commit-utils.js';
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

    let consecutiveFixFailures = 0;
    let lastFixSummary: string | undefined;

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

      const fix = await deps.runFix(ctx, { useFallback });
      lastFixSummary = fix.summary;
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

      if (fix.verdict === 'fixed' && fix.headBeforeFix && deps.git) {
        const verification = await verifyFixCommit({
          git: deps.git,
          cwd: ctx.cwd,
          expectedHead: fix.headBeforeFix,
        });
        if (verification.kind === 'uncommitted_changes') {
          this.emit(
            input,
            'fix.uncommitted_changes',
            'info',
            `validate-fix iteration ${iterationIndex} claimed fixed but HEAD did not advance and worktree has ${verification.dirtyFiles.length} dirty file(s); permitting and proceeding to validation`,
            {
              iterationIndex,
              invocationId: fix.invocationId,
              dirtyFiles: verification.dirtyFiles.slice(0, 200),
            },
          );
        }
      }

      consecutiveFixFailures = 0;

      // revalidate
      const reval = await deps.runRevalidation(ctx);

      if (reval.passed && deps.git) {
        const message = lastFixSummary ? `fix: ${lastFixSummary}` : 'fix: validation failures';
        await commitIfDirty({ git: deps.git, cwd: input.cwd, message });
      }

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
}
