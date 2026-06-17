import { describe, it, expect } from 'vitest';
import { RunId, PhaseName } from '../ids.js';
import { createStep } from '../step.js';

describe('createStep', () => {
  it('creates a pending step with no startedAt or completedAt', () => {
    const s = createStep({
      id: 'step-1',
      runId: RunId('run-1'),
      phaseId: PhaseName('validate'),
      index: 0,
      title: 'Typecheck',
    });

    expect(s.id).toBe('step-1');
    expect(s.runId).toBe('run-1');
    expect(s.status).toBe('pending');
    expect(s.startedAt).toBeUndefined();
    expect(s.completedAt).toBeUndefined();
  });
});
