import { describe, it, expect } from 'vitest';
import { createRun, transitionToReady, RepositoryId } from '@ai-sdlc/domain';
import type { Run } from '@ai-sdlc/domain';
import { applyReactivation, type ApplyReactivationDeps } from '../apply-reactivation.js';
import type { RunRepositoryPort, RunRepositoryUpdatePatch } from '../../ports.js';
import type { ReactivationDecision } from '../reactivate-on-review.js';

function readyRun(): Run {
  const run = createRun({
    uuid: '77777777-7777-7777-7777-777777777777',
    displayId: 'issue-7-20260604-000000',
    repoId: RepositoryId('owner/repo'),
    issueNumber: 7,
    startedAt: new Date('2026-06-04T00:00:00Z'),
    type: 'pr_review',
  });
  const running = { ...run, status: 'running' as const, currentPhase: undefined as undefined };
  return transitionToReady(running);
}

function makeDeps(overrides: Partial<ApplyReactivationDeps> = {}): ApplyReactivationDeps {
  return {
    runRepository: {
      update: (_uuid: string, _patch: RunRepositoryUpdatePatch) => {},
    } as RunRepositoryPort,
    eventBus: {
      publish: (_runUuid: string, _event: unknown) => {},
    } as never,
    now: () => new Date('2026-06-04T06:00:00Z'),
    ...overrides,
  };
}

describe('applyReactivation', () => {
  it('reactivate -> run becomes running and is persisted', () => {
    const updates: Array<{ uuid: string; patch: RunRepositoryUpdatePatch }> = [];
    const events: Array<unknown> = [];
    const deps = makeDeps({
      runRepository: {
        update: (uuid, patch) => updates.push({ uuid, patch }),
      } as RunRepositoryPort,
      eventBus: {
        publish: (_runUuid: string, event: unknown) => events.push(event),
      } as never,
    });
    const decision: ReactivationDecision = { action: 'reactivate', reason: 'new activity' };
    const out = applyReactivation(readyRun(), decision, deps);
    expect(out.status).toBe('running');
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.status).toBe('running');
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe('post-pr-review.run.reactivated');
  });

  it('timeout -> run becomes cancelled and is persisted', () => {
    const updates: Array<{ uuid: string; patch: RunRepositoryUpdatePatch }> = [];
    const events: Array<unknown> = [];
    const deps = makeDeps({
      runRepository: {
        update: (uuid, patch) => updates.push({ uuid, patch }),
      } as RunRepositoryPort,
      eventBus: {
        publish: (_runUuid: string, event: unknown) => events.push(event),
      } as never,
    });
    const decision: ReactivationDecision = { action: 'timeout', reason: 'deadline' };
    const out = applyReactivation(readyRun(), decision, deps);
    expect(out.status).toBe('cancelled');
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.status).toBe('cancelled');
    expect(events).toHaveLength(1);
    expect((events[0] as { type: string }).type).toBe('post-pr-review.run.timed_out');
  });

  it('unknown action -> throws', () => {
    const deps = makeDeps();
    const unknown = { action: 'bogus_action' as never, reason: 'unknown' };
    expect(() => applyReactivation(readyRun(), unknown, deps)).toThrow(
      'Unknown reactivation action: bogus_action',
    );
  });

  it('stay_ready -> run unchanged, not persisted, no event', () => {
    const updates: Array<unknown> = [];
    const events: Array<unknown> = [];
    const deps = makeDeps({
      runRepository: { update: () => updates.push(1) } as RunRepositoryPort,
      eventBus: { publish: () => events.push(1) } as never,
    });
    const before = readyRun();
    const decision: ReactivationDecision = { action: 'stay_ready', reason: 'resting' };
    const out = applyReactivation(before, decision, deps);
    expect(out.status).toBe('waiting');
    expect(out).toEqual(before);
    expect(updates).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});
