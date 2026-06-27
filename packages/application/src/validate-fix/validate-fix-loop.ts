import {
  createLoop,
  startIteration,
  completeIteration,
  canIterate,
  exhaust,
  type AgentProfileName,
} from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
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
    let consecutiveNoFixesNeeded = 0;

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
      const useFallback = consecutiveFixFailures >= 2;
      if (useFallback) {
        this.emitEscalation(input, 'two_consecutive_fix_failures');
      }

      const fix = await deps.runFix(ctx, { useFallback });
      loop = startIteration(loop, { reviewInvocationId: fix.invocationId, now: deps.now() });
      deps.loops.update(loop);

      if (fix.agentOutcome !== 'success') {
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
        consecutiveNoFixesNeeded += 1;
        if (consecutiveNoFixesNeeded >= 2) {
          loop = completeIteration(loop, {
            outcome: 'unresolved',
            fixInvocationId: fix.invocationId,
            now: deps.now(),
          });
          deps.loops.update(loop);
          this.emitIterationCompleted(input, iterationIndex, 'unresolved');
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

      if (fix.verdict === undefined || fix.verdict === 'cannot_fix') {
        consecutiveFixFailures += 1;
        consecutiveNoFixesNeeded = 0;
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
      consecutiveNoFixesNeeded = 0;

      // revalidate
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
}
