import { describe, it, expect } from 'vitest';
import { RunId, PhaseName } from '../ids.js';
import {
  createLoop,
  canIterate,
  startIteration,
  completeIteration,
  updateOpenIteration,
  exhaust,
  LoopStateError,
  type Loop,
} from '../loop.js';

const base = {
  id: 'loop-1',
  runId: RunId('run-1'),
  phaseId: PhaseName('whole-pr-review'),
  type: 'review-fix' as const,
};
const t0 = new Date('2026-06-14T00:00:00.000Z');
const t1 = new Date('2026-06-14T00:01:00.000Z');

function newLoop(maxIterations = 3): Loop {
  return createLoop({ ...base, maxIterations, now: t0 });
}

describe('createLoop', () => {
  it('starts running with no iterations', () => {
    const l = newLoop();
    expect(l.status).toBe('running');
    expect(l.iterations).toEqual([]);
    expect(l.startedAt).toBe(t0);
  });
  it('rejects maxIterations < 1', () => {
    expect(() => newLoop(0)).toThrow(LoopStateError);
  });
});

describe('canIterate', () => {
  it('is true until maxIterations reached, then false', () => {
    let l = newLoop(2);
    expect(canIterate(l)).toBe(true);
    l = completeIteration(startIteration(l, { reviewInvocationId: 'r1', now: t0 }), {
      outcome: 'unresolved',
      now: t1,
    });
    expect(canIterate(l)).toBe(true);
    l = completeIteration(startIteration(l, { reviewInvocationId: 'r2', now: t0 }), {
      outcome: 'unresolved',
      now: t1,
    });
    expect(canIterate(l)).toBe(false);
  });
  it('is false once converged', () => {
    let l = newLoop();
    l = completeIteration(startIteration(l, { reviewInvocationId: 'r1', now: t0 }), {
      outcome: 'resolved',
      now: t1,
    });
    expect(l.status).toBe('converged');
    expect(canIterate(l)).toBe(false);
  });
});

describe('startIteration', () => {
  it('appends a 1-based open iteration', () => {
    const l = startIteration(newLoop(), { reviewInvocationId: 'r1', now: t0 });
    expect(l.iterations).toHaveLength(1);
    expect(l.iterations[0]).toMatchObject({ index: 1, reviewInvocationId: 'r1', startedAt: t0 });
    expect(l.iterations[0]?.completedAt).toBeUndefined();
  });
  it('throws when an iteration is still open', () => {
    const l = startIteration(newLoop(), { reviewInvocationId: 'r1', now: t0 });
    expect(() => startIteration(l, { reviewInvocationId: 'r2', now: t0 })).toThrow(LoopStateError);
  });
  it('throws when over the iteration budget', () => {
    let l = newLoop(1);
    l = completeIteration(startIteration(l, { reviewInvocationId: 'r1', now: t0 }), {
      outcome: 'unresolved',
      now: t1,
    });
    expect(() => startIteration(l, { reviewInvocationId: 'r2', now: t0 })).toThrow(LoopStateError);
  });
  it('throws when loop is not running', () => {
    let l = newLoop();
    l = exhaust(l, t1);
    expect(() => startIteration(l, { reviewInvocationId: 'r1', now: t0 })).toThrow(LoopStateError);
  });
});

describe('completeIteration', () => {
  it('resolved → converged + sets completedAt', () => {
    let l = startIteration(newLoop(), { reviewInvocationId: 'r1', now: t0 });
    l = completeIteration(l, { outcome: 'resolved', fixInvocationId: 'f1', now: t1 });
    expect(l.status).toBe('converged');
    expect(l.completedAt).toBe(t1);
    expect(l.iterations[0]).toMatchObject({
      outcome: 'resolved',
      fixInvocationId: 'f1',
      completedAt: t1,
    });
  });
  it('failed → failed', () => {
    let l = startIteration(newLoop(), { reviewInvocationId: 'r1', now: t0 });
    l = completeIteration(l, { outcome: 'failed', now: t1 });
    expect(l.status).toBe('failed');
    expect(l.completedAt).toBe(t1);
  });
  it("'fixed' keeps loop running with no completedAt", () => {
    let l = startIteration(newLoop(), { reviewInvocationId: 'r1', now: t0 });
    l = completeIteration(l, { outcome: 'fixed', revalidationId: 'v1', now: t1 });
    expect(l.status).toBe('running');
    expect(l.completedAt).toBeUndefined();
    expect(l.iterations[0]?.revalidationId).toBe('v1');
  });
  it("'unresolved' keeps loop running with no completedAt", () => {
    let l = startIteration(newLoop(), { reviewInvocationId: 'r1', now: t0 });
    l = completeIteration(l, { outcome: 'unresolved', now: t1 });
    expect(l.status).toBe('running');
    expect(l.completedAt).toBeUndefined();
    expect(l.iterations[0]?.outcome).toBe('unresolved');
    expect(l.iterations[0]?.completedAt).toBe(t1);
  });
  it('throws when there is no open iteration', () => {
    const l = newLoop();
    expect(() => completeIteration(l, { outcome: 'fixed', now: t1 })).toThrow(LoopStateError);
  });
});

describe('updateOpenIteration', () => {
  it('sets qualityReviewInvocationId on the open iteration', () => {
    let l = startIteration(newLoop(), { reviewInvocationId: 'r1', now: t0 });
    l = updateOpenIteration(l, { qualityReviewInvocationId: 'qr1' });
    expect(l.iterations[0]?.qualityReviewInvocationId).toBe('qr1');
    expect(l.iterations[0]?.reviewInvocationId).toBe('r1');
  });
  it('throws when there is no open iteration', () => {
    const l = newLoop();
    expect(() => updateOpenIteration(l, { qualityReviewInvocationId: 'qr1' })).toThrow(
      LoopStateError,
    );
  });
});

describe('exhaust', () => {
  it('sets exhausted + completedAt', () => {
    const l = exhaust(newLoop(), t1);
    expect(l.status).toBe('exhausted');
    expect(l.completedAt).toBe(t1);
  });
  it('throws on an already-terminal loop', () => {
    const l = exhaust(newLoop(), t1);
    expect(() => exhaust(l, t1)).toThrow(LoopStateError);
  });
});
