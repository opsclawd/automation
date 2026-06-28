import { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandlerContext, PhaseResult } from '../handler.js';
import { createEventEmitter } from '../handler.js';
import { SingleShotAgentHandler } from './single-shot-agent-handler.js';
import { validatePlanTaskList } from '../plan-tasks.js';
import { ArtifactNotFoundError } from '../../ports/artifact-store.js';
import type { EventBusPort } from '../../ports/event-bus-port.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

export class PlanWriteHandler extends SingleShotAgentHandler {
  constructor() {
    super(PhaseName('plan-write'), 'plan-write', { skipResultExtraction: true });
  }

  override async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const emit = createEventEmitter(ctx, this.phase);

    const completedRef: { event?: { runUuid: string; event: OrchestratorEvent } } = {};
    const interceptedEvents: EventBusPort = {
      subscribe: (runUuid, listener) => ctx.events.subscribe(runUuid, listener),
      publish: (runUuid, event) => {
        if (event.type === 'plan-write.completed') {
          completedRef.event = { runUuid, event };
          return;
        }
        ctx.events.publish(runUuid, event);
      },
    };

    const wrappedCtx: PhaseHandlerContext = {
      ...ctx,
      events: interceptedEvents,
    };

    const result = await super.run(wrappedCtx);
    if (result.outcome !== 'passed') {
      return result;
    }

    let planMd: string;
    try {
      planMd = await ctx.artifacts.read(ctx.runUuid, 'plan.md');
    } catch (e) {
      const message = `Failed to read plan.md: ${e instanceof Error ? e.message : String(e)}`;
      emit('plan-write.failed', 'error', message);
      return {
        outcome: 'failed',
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'invalid_result',
          message,
          canRetry: false,
          suggestedAction: 'Ensure the agent generated a plan.',
          artifacts: [],
          detectedAt: ctx.now(),
        },
      };
    }

    let manifestJson: string | undefined;
    try {
      manifestJson = await ctx.artifacts.read(ctx.runUuid, 'task-manifest.json');
    } catch (e) {
      if (e instanceof ArtifactNotFoundError) {
        manifestJson = undefined;
      } else {
        const message = `Failed to read task-manifest.json: ${e instanceof Error ? e.message : String(e)}`;
        emit('plan-write.failed', 'error', message);
        return {
          outcome: 'failed',
          failure: {
            runUuid: ctx.runUuid,
            phase: this.phase,
            kind: 'unknown',
            message,
            canRetry: false,
            suggestedAction: 'Check artifact store permissions or integrity and retry.',
            artifacts: [],
            detectedAt: ctx.now(),
          },
        };
      }
    }

    const validation = validatePlanTaskList(planMd, manifestJson, ctx, 'plan-write');
    if (!validation.success) {
      emit('plan-write.failed', 'error', validation.error);
      return {
        outcome: 'failed',
        failure: {
          runUuid: ctx.runUuid,
          phase: this.phase,
          kind: 'invalid_result',
          message: validation.error,
          canRetry: false,
          suggestedAction: 'Review and fix the plan or task manifest structure.',
          artifacts: [],
          detectedAt: ctx.now(),
        },
      };
    }

    if (completedRef.event) {
      ctx.events.publish(completedRef.event.runUuid, completedRef.event.event);
    } else {
      emit('plan-write.completed', 'info', 'plan-write completed');
    }

    return result;
  }
}
