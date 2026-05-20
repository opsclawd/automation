import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  createRun,
  transitionToReady,
  reactivate,
  startPhase,
  passRun,
  RunStateError,
} from '../run.js';

const baseInput = { uuid: 'u', displayId: 'd', issueNumber: 1, startedAt: new Date('2026-01-01') };

describe('transitionToReady', () => {
  it('transitions a running run with no currentPhase to waiting', () => {
    const run = createRun(baseInput);
    const ready = transitionToReady(run);
    expect(ready.status).toBe('waiting');
  });

  it('rejects if a phase is still currentPhase', () => {
    let run = createRun(baseInput);
    run = { ...run, currentPhase: 'review' };
    expect(() => transitionToReady(run)).toThrow(RunStateError);
  });

  it('rejects if run is already terminal', () => {
    const run = { ...createRun(baseInput), status: 'passed' as const, completedAt: new Date() };
    expect(() => transitionToReady(run)).toThrow(RunStateError);
  });
});

describe('reactivate', () => {
  it('moves a waiting run back to running', () => {
    let run = createRun(baseInput);
    run = transitionToReady(run);
    const back = reactivate(run);
    expect(back.status).toBe('running');
  });

  it('rejects reactivating a non-waiting run', () => {
    const run = createRun(baseInput);
    expect(() => reactivate(run)).toThrow(RunStateError);
  });
});

describe('property: passRun requires no pending currentPhase', () => {
  it('passRun throws when called mid-phase', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (phaseName) => {
        let run = createRun(baseInput);
        run = startPhase(run, phaseName);
        expect(() => passRun(run, new Date())).toThrow();
      }),
    );
  });
});
