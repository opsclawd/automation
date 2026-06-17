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

  it('accepts an optional now parameter without error', () => {
    const t0 = new Date('2026-06-15T00:00:00.000Z');
    const s = createStep({
      id: 'step-2',
      runId: RunId('run-1'),
      phaseId: PhaseName('validate'),
      index: 1,
      title: 'Lint',
      now: t0,
    });

    expect(s.status).toBe('pending');
    // Pending steps have no startedAt regardless of now parameter.
    expect(s.startedAt).toBeUndefined();
  });
});
