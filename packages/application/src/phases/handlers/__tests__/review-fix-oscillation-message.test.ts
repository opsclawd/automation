import { describe, it, expect } from 'vitest';
import { ReviewFixHandler } from '../review-fix.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

function makeCtx() {
  const events: OrchestratorEvent[] = [];
  const ctx = {
    runId: 'human-readable-run',
    runUuid: '550e8400-e29b-41d4-a716-446655440000',
    repoFullName: 'acme/widgets',
    issueNumber: 7,
    cwd: '/tmp/wt',
    artifacts: {} as PhaseHandlerContext['artifacts'],
    github: {} as PhaseHandlerContext['github'],
    git: {} as PhaseHandlerContext['git'],
    agent: {} as PhaseHandlerContext['agent'],
    events: {
      publish: (_u: string, e: OrchestratorEvent) => {
        events.push(e);
      },
      subscribe: () => () => {},
    },
    now: () => new Date('2026-06-16T00:00:00Z'),
  } satisfies PhaseHandlerContext;
  return { ctx, events };
}

describe('ReviewFixHandler oscillation message', () => {
  it('persists the loop-provided disagreement as the human-review failure message', async () => {
    const disagreementReason =
      'Oscillation detected between contradictory reviewer demands: "Use a programmatic scenario loop in scenario.test.ts" and "Keep the explicit scenario table in scenario.test.ts"';

    const loopResult = {
      phaseOutcome: 'failed' as const,
      loopStatus: 'failed' as const,
      needsHumanReview: true,
      humanReviewReason: disagreementReason,
    };

    const runLoop = async () => loopResult;
    const { ctx } = makeCtx();
    const result = await new ReviewFixHandler({ runLoop }).run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.message).toBe(disagreementReason);
    }
  });
});
