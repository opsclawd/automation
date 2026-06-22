import { describe, expect, it } from 'vitest';
import { InMemoryStepRepository } from '../adapters/InMemoryStepRepository.js';
import { RunId, PhaseName, type Step } from '@ai-sdlc/domain';

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: 'step-1',
    runId: RunId('run-1'),
    phaseId: PhaseName('design'),
    index: 0,
    title: 'Design step',
    status: 'pending',
    ...overrides,
  };
}

describe('InMemoryStepRepository', () => {
  it('stores and lists steps for a run', () => {
    const repo = new InMemoryStepRepository();
    repo.upsert(makeStep());

    const steps = repo.listForRun(RunId('run-1'));
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe('step-1');
  });

  it('returns empty list for unknown run', () => {
    const repo = new InMemoryStepRepository();
    expect(repo.listForRun(RunId('unknown'))).toEqual([]);
  });

  it('finds step by composite key', () => {
    const repo = new InMemoryStepRepository();
    repo.upsert(makeStep());

    const found = repo.findByIndex(RunId('run-1'), PhaseName('design'), 0);
    expect(found).toBeDefined();
    expect(found!.id).toBe('step-1');
  });

  it('returns undefined for unknown composite key', () => {
    const repo = new InMemoryStepRepository();
    expect(repo.findByIndex(RunId('run-1'), PhaseName('design'), 0)).toBeUndefined();
  });

  it('upsert overwrites existing step with same key', () => {
    const repo = new InMemoryStepRepository();
    repo.upsert(makeStep({ title: 'first' }));
    repo.upsert(makeStep({ title: 'second' }));

    const steps = repo.listForRun(RunId('run-1'));
    expect(steps).toHaveLength(1);
    expect(steps[0].title).toBe('second');
  });

  it('sorts by phaseId then index', () => {
    const repo = new InMemoryStepRepository();
    repo.upsert(makeStep({ phaseId: PhaseName('build'), index: 1, id: 'step-2' }));
    repo.upsert(makeStep({ phaseId: PhaseName('build'), index: 0, id: 'step-1' }));
    repo.upsert(makeStep({ phaseId: PhaseName('analyze'), index: 0, id: 'step-0' }));

    const steps = repo.listForRun(RunId('run-1'));
    expect(steps.map((s) => s.id)).toEqual(['step-0', 'step-1', 'step-2']);
  });

  it('filters steps by runId across multiple runs', () => {
    const repo = new InMemoryStepRepository();
    repo.upsert(makeStep({ runId: RunId('run-1'), id: 'a' }));
    repo.upsert(makeStep({ runId: RunId('run-2'), id: 'b' }));

    const run1Steps = repo.listForRun(RunId('run-1'));
    expect(run1Steps).toHaveLength(1);
    expect(run1Steps[0].id).toBe('a');
  });

  it('returns copies not references', () => {
    const repo = new InMemoryStepRepository();
    const step = makeStep();
    repo.upsert(step);

    const retrieved = repo.listForRun(RunId('run-1'))[0]!;
    retrieved.title = 'mutated';

    const again = repo.listForRun(RunId('run-1'))[0]!;
    expect(again.title).toBe('Design step');
  });
});
