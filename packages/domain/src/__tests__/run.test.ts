import { describe, expect, it } from 'vitest';
import {
  createRun,
  startPhase,
  completePhase,
  skipPhase,
  passRun,
  failRun,
  RunStateError,
} from '../run.js';

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

  it('completePhase requires the matching phase name', () => {
    let r = createRun(base);
    r = startPhase(r, 'read_issue');
    expect(() => completePhase(r, 'other_phase')).toThrow(RunStateError);
  });

  it('completePhase clears currentPhase and appends to completedPhases', () => {
    let r = createRun(base);
    r = startPhase(r, 'read_issue');
    r = completePhase(r, 'read_issue');
    expect(r.completedPhases).toEqual(['read_issue']);
    expect(r.currentPhase).toBeUndefined();
  });

  it('completePhase throws when no phase is in progress', () => {
    const r = createRun(base);
    expect(() => completePhase(r, 'read_issue')).toThrow(RunStateError);
  });

  it('skipPhase clears currentPhase and appends to skippedPhases', () => {
    let r = createRun(base);
    r = startPhase(r, 'read_issue');
    r = skipPhase(r, 'read_issue');
    expect(r.skippedPhases).toEqual(['read_issue']);
    expect(r.completedPhases).toEqual([]);
    expect(r.currentPhase).toBeUndefined();
  });

  it('skipPhase requires the matching phase name', () => {
    let r = createRun(base);
    r = startPhase(r, 'read_issue');
    expect(() => skipPhase(r, 'other_phase')).toThrow(RunStateError);
  });

  it('skipPhase throws when no phase is in progress', () => {
    const r = createRun(base);
    expect(() => skipPhase(r, 'read_issue')).toThrow(RunStateError);
  });

  it('skipPhase does not add to completedPhases', () => {
    let r = createRun(base);
    r = startPhase(r, 'read_issue');
    r = skipPhase(r, 'read_issue');
    expect(r.completedPhases).toEqual([]);
    expect(r.skippedPhases).toEqual(['read_issue']);
  });

  it('startPhase throws when a phase is already in progress', () => {
    let r = createRun(base);
    r = startPhase(r, 'read_issue');
    expect(() => startPhase(r, 'plan')).toThrow(RunStateError);
  });

  it('startPhase throws on a terminal run', () => {
    const r = passRun(createRun(base), new Date());
    expect(() => startPhase(r, 'read_issue')).toThrow(RunStateError);
  });

  it('fails with reason', () => {
    const r = failRun(createRun(base), 'boom');
    expect(r.status).toBe('failed');
    expect(r.failureReason).toBe('boom');
  });

  it('passRun and failRun reject already-terminal runs', () => {
    const passed = passRun(createRun(base), new Date());
    expect(() => passRun(passed, new Date())).toThrow(RunStateError);
    expect(() => failRun(passed, 'late failure')).toThrow(RunStateError);
  });

  it('createRun accepts consolidate type', () => {
    const r = createRun({ ...base, type: 'consolidate' });
    expect(r.type).toBe('consolidate');
  });
});
