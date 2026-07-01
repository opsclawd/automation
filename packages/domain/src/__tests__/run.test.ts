import { describe, expect, it } from 'vitest';
import { RepositoryId } from '../ids.js';
import {
  createRun,
  startPhase,
  completePhase,
  skipPhase,
  passRun,
  failRun,
  blockRun,
  cancelRun,
  markRunNeedsHumanReview,
  canResume,
  resumeRun,
  RunStateError,
} from '../run.js';

const base = {
  uuid: '11111111-1111-1111-1111-111111111111',
  displayId: 'issue-1-20260513-000000',
  issueNumber: 1,
  repoId: RepositoryId('owner/repo'),
  startedAt: new Date('2026-05-13T00:00:00Z'),
};

describe('Run state machine', () => {
  it('requires and preserves repoId', () => {
    const r = createRun(base);
    expect(r.repoId).toBe('owner/repo');
  });

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

  it('marks run needs_human_review with reason, clears currentPhase', () => {
    let r = createRun(base);
    r = startPhase(r, 'implement');
    r = markRunNeedsHumanReview(r, 'step 2 needs human review');
    expect(r.status).toBe('needs_human_review');
    expect(r.failureReason).toBe('step 2 needs human review');
    expect(r.completedAt).toBeDefined();
    expect(r.currentPhase).toBeUndefined();
  });

  it('markRunNeedsHumanReview rejects terminal runs', () => {
    const passed = passRun(createRun(base), new Date());
    expect(() => markRunNeedsHumanReview(passed, 'nope')).toThrow(RunStateError);
    const failed = failRun(createRun(base), 'nope');
    expect(() => markRunNeedsHumanReview(failed, 'nope')).toThrow(RunStateError);
    const cancelled = cancelRun(createRun(base));
    expect(() => markRunNeedsHumanReview(cancelled, 'nope')).toThrow(RunStateError);
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

  describe('canResume', () => {
    it('returns true for failed runs', () => {
      const r = failRun(createRun(base), 'boom');
      expect(canResume(r)).toBe(true);
    });

    it('returns true for blocked runs', () => {
      const r = blockRun(createRun(base), 'blocked');
      expect(canResume(r)).toBe(true);
    });

    it('returns false for running, passed, cancelled, waiting runs', () => {
      expect(canResume(createRun(base))).toBe(false);
      expect(canResume(passRun(createRun(base), new Date()))).toBe(false);
      expect(canResume(cancelRun(createRun(base)))).toBe(false);
    });
  });

  describe('resumeRun', () => {
    it('transitions failed → running', () => {
      const r = failRun(createRun(base), 'boom');
      const resumed = resumeRun(r);
      expect(resumed.status).toBe('running');
    });

    it('clears completedAt and failureReason', () => {
      const r = failRun(createRun(base), 'boom');
      const resumed = resumeRun(r);
      expect(resumed.completedAt).toBeUndefined();
      expect(resumed.failureReason).toBeUndefined();
    });

    it('preserves completedPhases on full resume', () => {
      let r = createRun(base);
      r = startPhase(r, 'read_issue');
      r = completePhase(r, 'read_issue');
      r = startPhase(r, 'implement');
      r = failRun(r, 'boom');
      const resumed = resumeRun(r);
      expect(resumed.completedPhases).toEqual(['read_issue']);
      expect(resumed.skippedPhases).toEqual([]);
    });

    it('preserves skippedPhases on full resume', () => {
      let r = createRun(base);
      r = startPhase(r, 'skip_me');
      r = skipPhase(r, 'skip_me');
      r = failRun(r, 'boom');
      const resumed = resumeRun(r);
      expect(resumed.completedPhases).toEqual([]);
      expect(resumed.skippedPhases).toEqual(['skip_me']);
    });

    it('preserves completed and skipped phases on phase-specific resume', () => {
      let r = createRun(base);
      r = startPhase(r, 'read_issue');
      r = completePhase(r, 'read_issue');
      r = startPhase(r, 'implement');
      r = failRun(r, 'boom');
      const resumed = resumeRun(r, 'implement');
      expect(resumed.completedPhases).toEqual(['read_issue']);
      expect(resumed.skippedPhases).toEqual([]);
      expect(resumed.currentPhase).toBe('implement');
    });

    it('sets currentPhase when phase is provided', () => {
      const r = failRun(createRun(base), 'boom');
      const resumed = resumeRun(r, 'implement');
      expect(resumed.currentPhase).toBe('implement');
    });

    it('leaves currentPhase undefined when phase is not provided', () => {
      const r = failRun(createRun(base), 'boom');
      const resumed = resumeRun(r);
      expect(resumed.currentPhase).toBeUndefined();
    });

    it('throws when run is not failed', () => {
      const r = createRun(base);
      expect(() => resumeRun(r)).toThrow(RunStateError);
    });

    it('throws when run is passed', () => {
      const r = passRun(createRun(base), new Date());
      expect(() => resumeRun(r)).toThrow(RunStateError);
    });

    it('transitions blocked → running', () => {
      const r = blockRun(createRun(base), 'blocked');
      const resumed = resumeRun(r);
      expect(resumed.status).toBe('running');
    });
  });
});
