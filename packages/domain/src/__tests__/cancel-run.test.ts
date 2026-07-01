import { describe, expect, it } from 'vitest';
import { RepositoryId } from '../ids.js';
import { createRun, cancelRun, passRun, failRun, RunStateError } from '../run.js';

const base = {
  uuid: '11111111-1111-1111-1111-111111111111',
  displayId: 'issue-1-20260513-000000',
  repoId: RepositoryId('owner/repo'),
  issueNumber: 1,
  startedAt: new Date('2026-05-13T00:00:00Z'),
};

describe('cancelRun', () => {
  it('sets status to cancelled with completedAt and clears currentPhase', () => {
    const r = createRun(base);
    const completedAt = new Date('2026-05-13T01:00:00Z');
    const cancelled = cancelRun(r, 'user requested', completedAt);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.completedAt).toEqual(completedAt);
    expect(cancelled.failureReason).toBe('user requested');
    expect(cancelled.currentPhase).toBeUndefined();
  });

  it('cancels without a reason', () => {
    const r = createRun(base);
    const completedAt = new Date('2026-05-13T01:00:00Z');
    const cancelled = cancelRun(r, undefined, completedAt);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.failureReason).toBeUndefined();
  });

  it('rejects already-terminal runs', () => {
    const cancelled = cancelRun(createRun(base), 'test', new Date());
    expect(() => cancelRun(cancelled, 'late cancel', new Date())).toThrow(RunStateError);
    const passed = passRun(createRun(base), new Date());
    expect(() => cancelRun(passed, 'late cancel', new Date())).toThrow(RunStateError);
    const failed = failRun(createRun(base), 'boom');
    expect(() => cancelRun(failed, 'late cancel', new Date())).toThrow(RunStateError);
  });
});
