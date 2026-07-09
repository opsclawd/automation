import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, createLoop, startIteration, completeIteration } from '@ai-sdlc/domain';
import { openDatabase, applyMigrations } from '../../index.js';
import { LoopRepository } from '../loop-repository.js';

const t0 = new Date('2026-06-14T00:00:00.000Z');
const t1 = new Date('2026-06-14T00:01:00.000Z');

function setup() {
  const db = openDatabase(':memory:');
  applyMigrations(db);
  db.prepare(
    `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at, completed_phases)
     VALUES ('run-1', 'run-1', 1, 'issue_to_pr', 'running', '2026-06-14T00:00:00.000Z', '[]')`,
  ).run();
  return { db, repo: new LoopRepository(db) };
}

function twoIterationLoop() {
  let l = createLoop({
    id: 'loop-1',
    runId: RunId('run-1'),
    phaseId: PhaseName('whole-pr-review'),
    type: 'review-fix',
    maxIterations: 3,
    now: t0,
  });
  l = completeIteration(startIteration(l, { reviewInvocationId: 'r1', now: t0 }), {
    outcome: 'fixed',
    fixInvocationId: 'f1',
    revalidationId: 'v1',
    now: t1,
  });
  l = completeIteration(startIteration(l, { reviewInvocationId: 'r2', now: t0 }), {
    outcome: 'resolved',
    now: t1,
  });
  return l;
}

describe('LoopRepository', () => {
  it('round-trips insert → findById', () => {
    const { repo } = setup();
    const loop = twoIterationLoop();
    repo.insert(loop);
    expect(repo.findById('loop-1')).toEqual(loop);
  });

  it('update replaces iterations', () => {
    const { repo } = setup();
    let l = createLoop({
      id: 'loop-1',
      runId: RunId('run-1'),
      phaseId: PhaseName('whole-pr-review'),
      type: 'review-fix',
      maxIterations: 3,
      now: t0,
    });
    repo.insert(l);
    l = startIteration(l, { reviewInvocationId: 'r1', now: t0 });
    repo.update(l);
    expect(repo.findById('loop-1')?.iterations).toHaveLength(1);
    l = completeIteration(l, { outcome: 'resolved', now: t1 });
    repo.update(l);
    const stored = repo.findById('loop-1')!;
    expect(stored.status).toBe('converged');
    expect(stored.iterations[0]?.outcome).toBe('resolved');
  });

  it('update persists maxIterations changes', () => {
    const { repo } = setup();
    let l = createLoop({
      id: 'loop-1',
      runId: RunId('run-1'),
      phaseId: PhaseName('whole-pr-review'),
      type: 'review-fix',
      maxIterations: 3,
      now: t0,
    });
    repo.insert(l);
    l = { ...l, maxIterations: 4 };
    repo.update(l);
    expect(repo.findById('loop-1')?.maxIterations).toBe(4);
  });

  it('listForRun returns only loops for that run', () => {
    const { repo } = setup();
    repo.insert(twoIterationLoop());
    expect(repo.listForRun(RunId('run-1'))).toHaveLength(1);
    expect(repo.listForRun(RunId('run-2'))).toHaveLength(0);
  });

  it('findById returns undefined for unknown id', () => {
    const { repo } = setup();
    expect(repo.findById('nope')).toBeUndefined();
  });
});
