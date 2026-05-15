import { describe, expect, it } from 'vitest';
import { createRun, startPhase, completePhase, failRun } from '../run.js';

const base = {
  uuid: '11111111-1111-1111-1111-111111111111',
  displayId: 'issue-1-20260513-000000',
  issueNumber: 1,
  startedAt: new Date('2026-05-13T00:00:00Z'),
};

describe('Run state machine', () => {
  it('starts in running with no current phase', () => {
    const r = createRun(base);
    expect(r.status).toBe('running');
    expect(r.currentPhase).toBeUndefined();
  });

  it('transitions current phase', () => {
    let r = createRun(base);
    r = startPhase(r, 'read_issue');
    expect(r.currentPhase).toBe('read_issue');
  });

  it('marks completed phases', () => {
    let r = createRun(base);
    r = startPhase(r, 'read_issue');
    r = completePhase(r, 'read_issue');
    expect(r.completedPhases).toEqual(['read_issue']);
  });

  it('fails with reason', () => {
    const r = failRun(createRun(base), 'boom');
    expect(r.status).toBe('failed');
    expect(r.failureReason).toBe('boom');
  });
});
