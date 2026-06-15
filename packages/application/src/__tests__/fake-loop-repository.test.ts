import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, createLoop, startIteration, completeIteration } from '@ai-sdlc/domain';
import { FakeLoopRepository } from '../test-doubles/fake-loop-repository.js';

const t0 = new Date('2026-06-14T00:00:00.000Z');
const t1 = new Date('2026-06-14T00:01:00.000Z');

function loop(id: string, runUuid = 'run-1') {
  return createLoop({
    id,
    runId: RunId(runUuid),
    phaseId: PhaseName('whole-pr-review'),
    type: 'review-fix',
    maxIterations: 3,
    now: t0,
  });
}

describe('FakeLoopRepository', () => {
  it('insert + findById round-trips a deep clone (not the same reference)', () => {
    const repo = new FakeLoopRepository();
    const l = loop('loop-1');
    repo.insert(l);
    const got = repo.findById('loop-1')!;
    expect(got).toEqual(l);
    expect(got).not.toBe(l);
  });

  it('update reflects new iterations', () => {
    const repo = new FakeLoopRepository();
    let l = loop('loop-1');
    repo.insert(l);
    l = completeIteration(startIteration(l, { reviewInvocationId: 'r1', now: t0 }), {
      outcome: 'resolved',
      now: t1,
    });
    repo.update(l);
    expect(repo.findById('loop-1')?.status).toBe('converged');
  });

  it('listForRun filters by run', () => {
    const repo = new FakeLoopRepository();
    repo.insert(loop('a', 'run-1'));
    repo.insert(loop('b', 'run-2'));
    expect(repo.listForRun(RunId('run-1')).map((l) => l.id)).toEqual(['a']);
  });

  it('findById returns a clone, not the stored reference', () => {
    const repo = new FakeLoopRepository();
    repo.insert(loop('loop-1'));
    const a = repo.findById('loop-1')!;
    const b = repo.findById('loop-1')!;
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
