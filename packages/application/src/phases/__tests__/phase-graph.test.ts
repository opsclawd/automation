import { describe, it, expect } from 'vitest';
import { PhaseName } from '@ai-sdlc/domain';
import {
  CANONICAL_PHASE_ORDER,
  LEAN_PHASE_ORDER,
  resolvePhaseOrder,
  resolvePhaseGraph,
} from '../index.js';

describe('phase-graph', () => {
  it('resolves canonical order for legacy execution policy', () => {
    const order = resolvePhaseOrder('legacy');
    expect(order).toEqual(CANONICAL_PHASE_ORDER);
    expect(order).toContain(PhaseName('plan-write'));
    expect(order).toContain(PhaseName('plan-review'));
    expect(order).toContain(PhaseName('compound'));
    expect(order).toContain(PhaseName('post-pr-review'));

    const graph = resolvePhaseGraph('legacy');
    expect(graph.policy).toBe('legacy');
    expect(graph.scheduledPhases).toEqual(CANONICAL_PHASE_ORDER);
    expect(graph.isReachable('plan-write')).toBe(true);
  });

  it('resolves lean phase order for standard and strict policies', () => {
    const standardOrder = resolvePhaseOrder('standard');
    expect(standardOrder).toEqual(LEAN_PHASE_ORDER);

    const strictOrder = resolvePhaseOrder('strict');
    expect(strictOrder).toEqual(LEAN_PHASE_ORDER);

    // Lean order must contain initial-review, follow-up-review, wait-merge
    expect(standardOrder).toContain(PhaseName('initial-review'));
    expect(standardOrder).toContain(PhaseName('follow-up-review'));
    expect(standardOrder).toContain(PhaseName('wait-merge'));

    // Lean order must NOT contain legacy-only phases
    expect(standardOrder).not.toContain(PhaseName('plan-write'));
    expect(standardOrder).not.toContain(PhaseName('plan-review'));
    expect(standardOrder).not.toContain(PhaseName('compound'));
    expect(standardOrder).not.toContain(PhaseName('post-pr-review'));

    const graph = resolvePhaseGraph('standard');
    expect(graph.policy).toBe('standard');
    expect(graph.isReachable('initial-review')).toBe(true);
    expect(graph.isReachable('plan-write')).toBe(false);
  });

  it('computes first incomplete phase for lean runs on resume', () => {
    const graph = resolvePhaseGraph('standard');

    // Fresh run
    expect(
      graph.getFirstIncompletePhase({
        completedPhases: new Set(),
        skippedPhases: new Set(),
        skipSet: new Set(),
      }),
    ).toBe(PhaseName('read_issue'));

    // Resuming after implement
    expect(
      graph.getFirstIncompletePhase({
        completedPhases: new Set(['read_issue', 'plan-design', 'implement']),
        skippedPhases: new Set(),
        skipSet: new Set(),
      }),
    ).toBe(PhaseName('validate'));

    // Resuming after validate
    expect(
      graph.getFirstIncompletePhase({
        completedPhases: new Set(['read_issue', 'plan-design', 'implement', 'validate']),
        skippedPhases: new Set(),
        skipSet: new Set(),
      }),
    ).toBe(PhaseName('fix-validate'));
  });
});
