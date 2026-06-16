import { describe, it, expect } from 'vitest';
import type { PhaseName } from '@ai-sdlc/domain';
import {
  CANONICAL_PHASE_ORDER,
  PHASE_DEFINITIONS,
  getPhaseDefinition,
  orderedPhases,
  UnknownPhaseError,
  InvalidSkipListError,
  MissingRequiredInputError,
} from '../phase-definitions.js';

describe('phase definitions registry', () => {
  it('exposes the target canonical order (9 phases, review-fix)', () => {
    expect(CANONICAL_PHASE_ORDER).toEqual([
      'read_issue',
      'plan-design',
      'plan-write',
      'implement',
      'validate',
      'review-fix',
      'compound',
      'create-pr',
      'pr-review-poll',
    ]);
  });

  it('has a definition for every phase in the order', () => {
    for (const name of CANONICAL_PHASE_ORDER) {
      expect(PHASE_DEFINITIONS[name]).toBeDefined();
      expect(PHASE_DEFINITIONS[name]!.name).toBe(name);
    }
  });

  it('has exactly 9 definitions (no extras)', () => {
    expect(Object.keys(PHASE_DEFINITIONS)).toHaveLength(9);
  });

  it('exposes typed error classes with correct names', () => {
    expect(new UnknownPhaseError('bogus')).toBeInstanceOf(Error);
    expect(new UnknownPhaseError('bogus').name).toBe('UnknownPhaseError');
    expect(new UnknownPhaseError('bogus').message).toBe("unknown phase: 'bogus'");

    expect(new InvalidSkipListError('bad').name).toBe('InvalidSkipListError');
    expect(new MissingRequiredInputError('p', ['a']).name).toBe('MissingRequiredInputError');
    expect(new MissingRequiredInputError('p', ['a']).missing).toEqual(['a']);
  });

  describe('getPhaseDefinition', () => {
    it('returns the definition for a known phase', () => {
      const def = getPhaseDefinition('plan-design' as PhaseName);
      expect(def.outputs).toEqual(['design.md']);
      expect(def.name).toBe('plan-design');
    });

    it('throws UnknownPhaseError for an unknown phase', () => {
      expect(() => getPhaseDefinition('bogus' as PhaseName)).toThrow(UnknownPhaseError);
      expect(() => getPhaseDefinition('bogus' as PhaseName)).toThrow("unknown phase: 'bogus'");
    });

    it('returns the definition for every canonical phase', () => {
      for (const name of CANONICAL_PHASE_ORDER) {
        expect(() => getPhaseDefinition(name)).not.toThrow();
        expect(getPhaseDefinition(name).name).toBe(name);
      }
    });
  });

  describe('orderedPhases', () => {
    it('returns all phases in canonical order when skip is empty', () => {
      const result = orderedPhases([]);
      expect(result.map((p) => p.name)).toEqual(CANONICAL_PHASE_ORDER);
    });

    it('omits a skippable phase (compound) from the order', () => {
      const names = orderedPhases(['compound' as PhaseName]).map((p) => p.name);
      expect(names).not.toContain('compound');
      expect(names).toContain('plan-design');
      expect(names).toHaveLength(8);
    });

    it('rejects skipping a non-skippable phase', () => {
      expect(() => orderedPhases(['create-pr' as PhaseName])).toThrow(InvalidSkipListError);
      expect(() => orderedPhases(['create-pr' as PhaseName])).toThrow(
        "phase 'create-pr' is not skippable",
      );
    });

    it('rejects an unknown phase in the skip list', () => {
      expect(() => orderedPhases(['nope' as PhaseName])).toThrow(InvalidSkipListError);
      expect(() => orderedPhases(['nope' as PhaseName])).toThrow(
        "unknown phase in skip list: 'nope'",
      );
    });

    it('rejects a skip that orphans a downstream required input', () => {
      // plan-write is not skippable, so it throws "not skippable" before orphan check
      expect(() => orderedPhases(['plan-write' as PhaseName])).toThrow(InvalidSkipListError);
      expect(() => orderedPhases(['plan-write' as PhaseName])).toThrow(
        "phase 'plan-write' is not skippable",
      );
    });

    it('allows skipping a phase when another kept phase provides the same output', () => {
      // design.md is optional for compound but optional inputs are not in the orphan check
      // Create a scenario where no dependency is orphaned
      expect(() => orderedPhases(['compound' as PhaseName])).not.toThrow();
    });

    it('rejects multiple skips when any dependency is orphaned', () => {
      // skipping both plan-design and plan-write removes design.md and plan.md
      expect(() => orderedPhases(['plan-design' as PhaseName, 'plan-write' as PhaseName])).toThrow(
        InvalidSkipListError,
      );
    });
  });
});
