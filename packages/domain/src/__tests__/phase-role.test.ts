import { describe, it, expect } from 'vitest';
import { PHASE_ROLES, DEFAULT_PHASE_TO_ROLE, isPhaseRole, type PhaseRole } from '../phase-role.js';

describe('phase-role domain definitions', () => {
  it('defines the 6 canonical phase roles', () => {
    expect(PHASE_ROLES).toEqual([
      'planner',
      'implementer',
      'fixer',
      'critic',
      'pr-reviewer',
      'task-agent',
    ]);
  });

  it('validates PhaseRole values with isPhaseRole', () => {
    for (const role of PHASE_ROLES) {
      expect(isPhaseRole(role)).toBe(true);
    }
    expect(isPhaseRole('')).toBe(false);
    expect(isPhaseRole('unknown')).toBe(false);
    expect(isPhaseRole(null)).toBe(false);
    expect(isPhaseRole(undefined)).toBe(false);
    expect(isPhaseRole(123)).toBe(false);
  });

  it('maps all standard pipeline phases to a valid PhaseRole', () => {
    const expectedPhases = [
      'plan-design',
      'architecture-review',
      'architecture-fix',
      'implement',
      'quality-review',
      'spec-review',
      'post-implementation-spec-review',
      'post-implementation-quality-review',
      'follow-up-review',
      'fix-review',
      'fix-validate',
      'whole-pr-fix-review',
      'compound',
      'create-pr',
      'result-writer',
    ];

    for (const phase of expectedPhases) {
      const role = DEFAULT_PHASE_TO_ROLE[phase];
      expect(role, `Phase '${phase}' must map to a defined PhaseRole`).toBeDefined();
      expect(isPhaseRole(role)).toBe(true);
    }
  });

  it('DEFAULT_PHASE_TO_ROLE is immutable', () => {
    expect(() => {
      (DEFAULT_PHASE_TO_ROLE as Record<string, PhaseRole>)['new-phase'] = 'planner';
    }).toThrow();
  });
});
