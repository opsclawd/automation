import { describe, it, expect, vi } from 'vitest';
import { PostPrReviewHandler } from '../post-pr-review.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

function ctx() {
  const events: OrchestratorEvent[] = [];
  const c = {
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
  return { ctx: c, events };
}

describe('PostPrReviewHandler', () => {
  it('emits phase.started on every run', async () => {
    const setRunStatus = vi.fn();
    const handler = new PostPrReviewHandler({
      runPoll: async () => ({ signal: 'pending' as const }),
      setRunStatus,
      readyMaxDays: 7,
    });
    const { ctx: c, events } = ctx();
    await handler.run(c);
    const started = events.filter((e) => e.type === 'phase.started');
    expect(started).toHaveLength(1);
    expect(started[0].phase).toBe('post-pr-review');
    expect(started[0].level).toBe('info');
  });

  it('transitions to SUCCESS (passed) when the PR is merged', async () => {
    const setRunStatus = vi.fn();
    const handler = new PostPrReviewHandler({
      runPoll: async () => ({ signal: 'merged' as const }),
      setRunStatus,
      readyMaxDays: 7,
    });
    const { ctx: c, events } = ctx();
    const res = await handler.run(c);
    expect(res.outcome).toBe('passed');
    expect(setRunStatus).toHaveBeenCalledWith('passed');
    expect(events.some((e) => e.type === 'run.completed')).toBe(true);
  });

  it('transitions the Run to READY (waiting) when the poller reports all_resolved', async () => {
    const setRunStatus = vi.fn();
    const handler = new PostPrReviewHandler({
      runPoll: async () => ({ signal: 'all_resolved' as const }),
      setRunStatus,
      readyMaxDays: 7,
    });
    const { ctx: c, events } = ctx();
    const res = await handler.run(c);
    expect(res.outcome).toBe('passed');
    expect(setRunStatus).toHaveBeenCalledWith('waiting');
    expect(events.some((e) => e.type === 'run.ready')).toBe(true);
  });

  it('continues (no status change) when poller returns pending', async () => {
    const setRunStatus = vi.fn();
    const handler = new PostPrReviewHandler({
      runPoll: async () => ({ signal: 'pending' as const }),
      setRunStatus,
      readyMaxDays: 7,
    });
    const { ctx: c, events } = ctx();
    const res = await handler.run(c);
    expect(res.outcome).toBe('passed');
    expect(setRunStatus).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'post-pr-review.poll.pending')).toBe(true);
    expect(events.filter((e) => e.type === 'post-pr-review.poll.pending')[0].phase).toBe(
      'post-pr-review',
    );
  });
});
