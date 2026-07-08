import { PhaseName, RunId } from '@ai-sdlc/domain';
import type { FailureKind } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult, EventEmitter } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import type { PlanReviewLoop } from '../../plan-review/plan-review-loop.js';
import type { PlanReviewLoopResult } from '../../plan-review/types.js';

export interface PlanReviewHandlerOpts {
  loop: PlanReviewLoop;
  maxIterations: number;
  enabled: boolean;
}

export class PlanReviewHandler implements PhaseHandler {
  readonly phase = PhaseName('plan-review');

  constructor(private readonly opts: PlanReviewHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);
    emit('plan-review.started', 'info', 'plan-review started');

    if (!this.opts.enabled) {
      // AC #4: behaviour unchanged when disabled.
      emit('plan-review.skipped', 'info', 'plan-review disabled by config; skipping');
      return { outcome: 'passed' };
    }

    // Validate plan.md exists before invoking the loop.
    try {
      await ctx.artifacts.read(ctx.runUuid, 'plan.md');
    } catch (e) {
      const message =
        e instanceof ArtifactNotFoundError
          ? 'plan.md not found in artifact store'
          : `Failed to read plan.md: ${e instanceof Error ? e.message : String(e)}`;
      return this.fail(ctx, emit, 'missing_artifact', message);
    }

    let result: PlanReviewLoopResult;
    try {
      result = await this.opts.loop.execute({
        runId: RunId(ctx.runUuid),
        phaseId: this.phase,
        repoId: ctx.repoFullName,
        cwd: ctx.cwd,
        maxIterations: this.opts.maxIterations,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return this.fail(ctx, emit, 'unknown', `plan-review loop crashed: ${message}`);
    }

    if (result.outcome === 'success') {
      // AC #3: append known limitations to plan.md when proceed_with_concerns.
      if (result.proceedWithConcerns && result.knownLimitations) {
        try {
          const planMd = await ctx.artifacts.read(ctx.runUuid, 'plan.md');
          const section = '## Known Limitations';

          let updated = planMd.trimEnd();
          if (!planMd.includes(section)) {
            updated += `\n\n${section}`;
          }
          updated += `\n\n${result.knownLimitations}\n`;

          await ctx.artifacts.write({
            runId: ctx.runUuid,
            phaseId: this.phase,
            relativePath: 'plan.md',
            contents: updated,
          });
          emit(
            'plan-review.known_limitations_appended',
            'info',
            'appended Known Limitations section',
          );
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          emit('plan-review.known_limitations_append_failed', 'warn', message);
        }
      }
      emit('plan-review.completed', 'info', 'plan-review completed');
      return { outcome: 'passed' };
    }

    if (result.outcome === 'needs_human_review') {
      emit('plan-review.needs_human_review', 'warn', 'plan-review escalated to human review');
      return this.needsHumanReview(ctx, emit);
    }

    emit('plan-review.failed', 'error', 'plan-review failed');
    return this.fail(ctx, emit, 'agent_incomplete', 'plan-review loop failed');
  }

  private fail(
    ctx: PhaseHandlerContext,
    _emit: EventEmitter,
    kind: FailureKind,
    message: string,
  ): PhaseResult {
    return {
      outcome: 'failed',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'plan-review',
        kind,
        message,
        canRetry: kind !== 'invalid_result',
        suggestedAction: 'Inspect the plan-review artifacts and resume.',
        artifacts: [],
        detectedAt: ctx.now(),
      },
    };
  }

  private needsHumanReview(ctx: PhaseHandlerContext, _emit: EventEmitter): PhaseResult {
    return {
      outcome: 'needs_human_review',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'plan-review',
        kind: 'agent_incomplete',
        message: 'plan-review exhausted or escalated',
        canRetry: true,
        suggestedAction:
          'Review the plan-review findings and either revise plan.md manually or resume the run.',
        artifacts: [],
        detectedAt: ctx.now(),
      },
    };
  }
}
