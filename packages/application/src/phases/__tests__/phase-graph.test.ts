import { describe, it, expect } from 'vitest';
import { PhaseName } from '@ai-sdlc/domain';
import {
  CANONICAL_PHASE_ORDER,
  STANDARD_LEAN_PHASE_ORDER,
  STRICT_LEAN_PHASE_ORDER,
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

  it('resolves distinct lean phase orders for standard and strict policies', () => {
    const standardOrder = resolvePhaseOrder('standard');
    expect(standardOrder).toEqual(STANDARD_LEAN_PHASE_ORDER);
    expect(standardOrder).toEqual(LEAN_PHASE_ORDER);

    const strictOrder = resolvePhaseOrder('strict');
    expect(strictOrder).toEqual(STRICT_LEAN_PHASE_ORDER);

    // Standard must NOT contain architecture-review
    expect(standardOrder).not.toContain(PhaseName('architecture-review'));

    // Strict must contain architecture-review immediately after plan-design and before implement
    expect(strictOrder).toContain(PhaseName('architecture-review'));
    const planDesignIdx = strictOrder.indexOf(PhaseName('plan-design'));
    const archReviewIdx = strictOrder.indexOf(PhaseName('architecture-review'));
    const implementIdx = strictOrder.indexOf(PhaseName('implement'));
    expect(archReviewIdx).toBe(planDesignIdx + 1);
    expect(implementIdx).toBe(archReviewIdx + 1);

    // Both lean orders must contain initial-review, follow-up-review, wait-merge
    expect(standardOrder).toContain(PhaseName('initial-review'));
    expect(standardOrder).toContain(PhaseName('follow-up-review'));
    expect(standardOrder).toContain(PhaseName('wait-merge'));

    expect(strictOrder).toContain(PhaseName('initial-review'));
    expect(strictOrder).toContain(PhaseName('follow-up-review'));
    expect(strictOrder).toContain(PhaseName('wait-merge'));

    // Lean orders must NOT contain legacy-only phases
    expect(standardOrder).not.toContain(PhaseName('plan-write'));
    expect(standardOrder).not.toContain(PhaseName('plan-review'));
    expect(standardOrder).not.toContain(PhaseName('compound'));
    expect(standardOrder).not.toContain(PhaseName('post-pr-review'));

    expect(strictOrder).not.toContain(PhaseName('plan-write'));
    expect(strictOrder).not.toContain(PhaseName('plan-review'));
    expect(strictOrder).not.toContain(PhaseName('compound'));
    expect(strictOrder).not.toContain(PhaseName('post-pr-review'));

    const standardGraph = resolvePhaseGraph('standard');
    expect(standardGraph.policy).toBe('standard');
    expect(standardGraph.isReachable('initial-review')).toBe(true);
    expect(standardGraph.isReachable('architecture-review')).toBe(false);
    expect(standardGraph.isReachable('plan-write')).toBe(false);

    const strictGraph = resolvePhaseGraph('strict');
    expect(strictGraph.policy).toBe('strict');
    expect(strictGraph.isReachable('initial-review')).toBe(true);
    expect(strictGraph.isReachable('architecture-review')).toBe(true);
    expect(strictGraph.isReachable('plan-write')).toBe(false);
  });

  it('computes first incomplete phase for standard lean runs on resume', () => {
    const graph = resolvePhaseGraph('standard');

    // Fresh run
    expect(
      graph.getFirstIncompletePhase({
        completedPhases: new Set(),
        skippedPhases: new Set(),
        skipSet: new Set(),
      }),
    ).toBe(PhaseName('read_issue'));

    // Resuming after plan-design in standard policy directly proceeds to implement
    expect(
      graph.getFirstIncompletePhase({
        completedPhases: new Set(['read_issue', 'plan-design']),
        skippedPhases: new Set(),
        skipSet: new Set(),
      }),
    ).toBe(PhaseName('implement'));

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

  it('computes first incomplete phase for strict lean runs on resume', () => {
    const graph = resolvePhaseGraph('strict');

    // Fresh run
    expect(
      graph.getFirstIncompletePhase({
        completedPhases: new Set(),
        skippedPhases: new Set(),
        skipSet: new Set(),
      }),
    ).toBe(PhaseName('read_issue'));

    // Resuming after plan-design in strict policy proceeds to architecture-review
    expect(
      graph.getFirstIncompletePhase({
        completedPhases: new Set(['read_issue', 'plan-design']),
        skippedPhases: new Set(),
        skipSet: new Set(),
      }),
    ).toBe(PhaseName('architecture-review'));

    // Resuming after architecture-review in strict policy proceeds to implement
    expect(
      graph.getFirstIncompletePhase({
        completedPhases: new Set(['read_issue', 'plan-design', 'architecture-review']),
        skippedPhases: new Set(),
        skipSet: new Set(),
      }),
    ).toBe(PhaseName('implement'));
  });
});
