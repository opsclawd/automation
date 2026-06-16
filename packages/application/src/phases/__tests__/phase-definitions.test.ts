import { describe, it, expect } from 'vitest';
import type { PhaseName } from '@ai-sdlc/domain';
import {
  CANONICAL_PHASE_ORDER,
  PHASE_DEFINITIONS,
  getPhaseDefinition,
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
});
