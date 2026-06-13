import { reactivate, cancelRun } from '@ai-sdlc/domain';
import type { Run } from '@ai-sdlc/domain';
import type { RunRepositoryPort } from '../ports.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { ReactivationDecision } from './reactivate-on-review.js';

export interface ApplyReactivationDeps {
  runRepository: RunRepositoryPort;
  eventBus: EventBusPort;
  now: () => Date;
}

export function applyReactivation(
  run: Run,
  decision: ReactivationDecision,
  deps: ApplyReactivationDeps,
): Run {
  switch (decision.action) {
    case 'reactivate': {
      const next = reactivate(run);
      deps.runRepository.update(run.uuid, { status: next.status });
      deps.eventBus.publish(run.uuid, {
        runId: run.uuid,
        phase: 'post-pr-review',
        level: 'info',
        type: 'post-pr-review.run.reactivated',
        message: decision.reason,
        timestamp: deps.now().toISOString(),
        metadata: { reason: decision.reason },
      });
      return next;
    }
    case 'timeout': {
      const next = cancelRun(run, decision.reason, deps.now());
      deps.runRepository.update(run.uuid, {
        status: next.status,
        ...(next.completedAt ? { completedAt: next.completedAt } : {}),
        ...(next.failureReason ? { failureReason: next.failureReason } : {}),
      });
      deps.eventBus.publish(run.uuid, {
        runId: run.uuid,
        phase: 'post-pr-review',
        level: 'warn',
        type: 'post-pr-review.run.timed_out',
        message: decision.reason,
        timestamp: deps.now().toISOString(),
        metadata: { reason: decision.reason },
      });
      return next;
    }
    case 'stay_ready':
      return run;
    default:
      throw new Error(`Unknown reactivation action: ${(decision as { action: string }).action}`);
  }
}
