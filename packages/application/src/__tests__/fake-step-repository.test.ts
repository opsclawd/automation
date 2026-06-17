import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, createStep } from '@ai-sdlc/domain';
import { FakeStepRepository } from '../test-doubles/fake-step-repository.js';

const runId = RunId('run-1');
const phaseId = PhaseName('validate');

function step(
  index: number,
  overrides: Partial<{ id: string; title: string; runId: string }> = {},
) {
  return createStep({
    id: overrides.id ?? `step-${index}`,
    runId: RunId(overrides.runId ?? 'run-1'),
    phaseId,
    index,
    title: overrides.title ?? `Task ${index}`,
  });
}

describe('FakeStepRepository', () => {
  it('upsert + findByIndex round-trips with a clone (not the same reference)', () => {
    const repo = new FakeStepRepository();
    const s = step(0);
    repo.upsert(s);
    const got = repo.findByIndex(runId, phaseId, 0);
    expect(got).toEqual(s);
    expect(got).not.toBe(s);
  });

  it('findByIndex returns undefined for a missing step', () => {
    const repo = new FakeStepRepository();
    expect(repo.findByIndex(runId, phaseId, 0)).toBeUndefined();
  });

  it('listForRun returns all steps for a run, sorted by (phaseId, index)', () => {
    const repo = new FakeStepRepository();
    const phaseB = PhaseName('build');
    repo.upsert(createStep({ id: 's1', runId, phaseId: phaseB, index: 0, title: 'B1' }));
    repo.upsert(createStep({ id: 's2', runId, phaseId, index: 0, title: 'V1' }));
    repo.upsert(createStep({ id: 's3', runId, phaseId, index: 1, title: 'V2' }));

    const listed = repo.listForRun(runId);
    expect(listed.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
  });

  it('listForRun returns an empty array for a run with no steps', () => {
    const repo = new FakeStepRepository();
    expect(repo.listForRun(runId)).toEqual([]);
  });

  it('upsert overwrites an existing step (idempotent upsert)', () => {
    const repo = new FakeStepRepository();
    repo.upsert(step(0, { title: 'Original' }));
    repo.upsert(step(0, { title: 'Updated' }));
    const got = repo.findByIndex(runId, phaseId, 0);
    expect(got?.title).toBe('Updated');
    // Exactly one step: upsert is replace, not append.
    expect(repo.listForRun(runId)).toHaveLength(1);
  });

  it('listForRun returns clones, not stored references', () => {
    const repo = new FakeStepRepository();
    repo.upsert(step(0));
    const a = repo.listForRun(runId)[0]!;
    const b = repo.listForRun(runId)[0]!;
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
