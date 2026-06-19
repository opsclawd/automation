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

describe('ReviewFixHandler', () => {
  it('returns passed when the loop converges', async () => {
    const runLoop = async () => ({
      phaseOutcome: 'passed' as const,
      loopStatus: 'converged' as const,
    });
    const { ctx } = makeCtx();
    const result = await new ReviewFixHandler({ runLoop }).run(ctx);
    expect(result.outcome).toBe('passed');
  });

  it('returns failed with validation_failed when the loop exhausts', async () => {
    const runLoop = async () => ({
      phaseOutcome: 'failed' as const,
      loopStatus: 'exhausted' as const,
    });
    const { ctx } = makeCtx();
    const result = await new ReviewFixHandler({ runLoop }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('validation_failed');
      expect(result.failure.message).toBe('review/fix loop exhausted without converging');
      expect(result.failure.phase).toBe('review-fix');
      expect(result.failure.canRetry).toBe(true);
      expect(result.failure.artifacts).toEqual(['review.md']);
      expect(result.failure.runUuid).toBe('550e8400-e29b-41d4-a716-446655440000');
    }
  });

  it('returns failed with validation_failed when the loop fails on agent error', async () => {
    const runLoop = async () => ({
      phaseOutcome: 'failed' as const,
      loopStatus: 'failed' as const,
    });
    const { ctx } = makeCtx();
    const result = await new ReviewFixHandler({ runLoop }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('validation_failed');
      expect(result.failure.message).toBe('review/fix loop failed');
      expect(result.failure.phase).toBe('review-fix');
      expect(result.failure.canRetry).toBe(true);
    }
  });

  describe('event emission', () => {
    it('emits phase.started and phase.completed on convergence', async () => {
      const runLoop = async () => ({
        phaseOutcome: 'passed' as const,
        loopStatus: 'converged' as const,
      });
      const { ctx, events } = makeCtx();
      await new ReviewFixHandler({ runLoop }).run(ctx);

      const started = events.filter((e) => e.type === 'review_fix.started');
      expect(started).toHaveLength(1);
      expect(started[0].runId).toBe('human-readable-run');
      expect(started[0].timestamp).toBe('2026-06-16T00:00:00.000Z');
      expect(started[0].level).toBe('info');
      expect(started[0].phase).toBe('review-fix');

      const completed = events.filter((e) => e.type === 'review_fix.completed');
      expect(completed).toHaveLength(1);
      expect(completed[0].runId).toBe('human-readable-run');
      expect(completed[0].timestamp).toBe('2026-06-16T00:00:00.000Z');
      expect(completed[0].level).toBe('info');
      expect(completed[0].phase).toBe('review-fix');
    });

    it('emits phase.started and phase.failed on exhaustion', async () => {
      const runLoop = async () => ({
        phaseOutcome: 'failed' as const,
        loopStatus: 'exhausted' as const,
      });
      const { ctx, events } = makeCtx();
      await new ReviewFixHandler({ runLoop }).run(ctx);

      const started = events.filter((e) => e.type === 'review_fix.started');
      expect(started).toHaveLength(1);
      expect(started[0].phase).toBe('review-fix');

      const failed = events.filter((e) => e.type === 'review_fix.failed');
      expect(failed).toHaveLength(1);
      expect(failed[0].runId).toBe('human-readable-run');
      expect(failed[0].timestamp).toBe('2026-06-16T00:00:00.000Z');
      expect(failed[0].level).toBe('error');
      expect(failed[0].phase).toBe('review-fix');
      expect(failed[0].message).toBe('review-fix loop exhausted');
    });

    it('emits phase.started and phase.failed on agent failure', async () => {
      const runLoop = async () => ({
        phaseOutcome: 'failed' as const,
        loopStatus: 'failed' as const,
      });
      const { ctx, events } = makeCtx();
      await new ReviewFixHandler({ runLoop }).run(ctx);

      const started = events.filter((e) => e.type === 'review_fix.started');
      expect(started).toHaveLength(1);
      expect(started[0].phase).toBe('review-fix');

      const failed = events.filter((e) => e.type === 'review_fix.failed');
      expect(failed).toHaveLength(1);
      expect(failed[0].message).toBe('review-fix loop failed');
    });

    it('returns a failure when runLoop throws', async () => {
      const runLoop = async () => {
        throw new Error('DB write failed');
      };
      const { ctx, events } = makeCtx();
      const result = await new ReviewFixHandler({ runLoop }).run(ctx);

      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.failure.kind).toBe('unknown');
        expect(result.failure.message).toBe('review/fix loop threw: DB write failed');
        expect(result.failure.phase).toBe('review-fix');
        expect(result.failure.canRetry).toBe(true);
      }

      const failed = events.filter((e) => e.type === 'review_fix.failed');
      expect(failed).toHaveLength(1);
      expect(failed[0].message).toBe('review/fix loop threw: DB write failed');
    });

    it('does not emit phase.completed on exhaustion', async () => {
      const runLoop = async () => ({
        phaseOutcome: 'failed' as const,
        loopStatus: 'exhausted' as const,
      });
      const { ctx, events } = makeCtx();
      await new ReviewFixHandler({ runLoop }).run(ctx);

      const completed = events.filter((e) => e.type === 'review_fix.completed');
      expect(completed).toHaveLength(0);
    });
  });
});
