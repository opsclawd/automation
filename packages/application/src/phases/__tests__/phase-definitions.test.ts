import { describe, it, expect } from 'vitest';
import type { PhaseName } from '@ai-sdlc/domain';
import {
  CANONICAL_PHASE_ORDER,
  PHASE_DEFINITIONS,
  clonePhaseDefinitions,
  getPhaseDefinition,
  orderedPhases,
  nextPhase,
  assertInputsAvailable,
  UnknownPhaseError,
  InvalidSkipListError,
  MissingRequiredInputError,
} from '../phase-definitions.js';

describe('phase definitions registry', () => {
  it('exposes the target canonical order (11 lean phases)', () => {
    expect(CANONICAL_PHASE_ORDER).toEqual([
      'read_issue',
      'plan-design',
      'implement',
      'validate',
      'fix-validate',
      'spec-review',
      'quality-review',
      'fix-review',
      'follow-up-review',
      'create-pr',
      'wait-merge',
    ]);
  });

  it('has a definition for every phase in the order', () => {
    for (const name of CANONICAL_PHASE_ORDER) {
      expect(PHASE_DEFINITIONS[name]).toBeDefined();
      expect(PHASE_DEFINITIONS[name]!.name).toBe(name);
    }
  });

  it('has exactly 13 definitions (no extras)', () => {
    expect(Object.keys(PHASE_DEFINITIONS)).toHaveLength(13);
  });

  it('defines architecture-review with required inputs issue.md, design.md, plan.md', () => {
    const def = getPhaseDefinition('architecture-review' as PhaseName);
    expect(def.inputs.required).toEqual(['issue.md', 'design.md', 'plan.md']);
    expect(def.inputs.optional).toEqual(['issue-comments.md']);
    expect(def.outputs).toEqual([
      'architecture-review.json',
      'architecture-review.md',
      'architecture-requirements.json',
    ]);
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
      expect(def.outputs).toEqual(['design.md', 'plan.md']);
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
      expect(names).toHaveLength(11);
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
      const defs = clonePhaseDefinitions();
      defs['plan-design'].skippable = true;
      expect(() => orderedPhases(['plan-design' as PhaseName], defs)).toThrow(InvalidSkipListError);
      expect(() => orderedPhases(['plan-design' as PhaseName], defs)).toThrow(
        /orphans required input/,
      );
    });

    it('allows skipping the only skippable phase (compound) when no downstream deps are orphaned', () => {
      // design.md is optional for compound but optional inputs are not in the orphan check
      // Create a scenario where no dependency is orphaned
      expect(() => orderedPhases(['compound' as PhaseName])).not.toThrow();
    });

    it('rejects multiple skips when any dependency is orphaned', () => {
      const defs = clonePhaseDefinitions();
      defs['plan-design'].skippable = true;
      defs['implement'].skippable = true;
      expect(() =>
        orderedPhases(['plan-design' as PhaseName, 'implement' as PhaseName], defs),
      ).toThrow(InvalidSkipListError);
    });
  });

  describe('nextPhase', () => {
    it('returns the following phase in canonical order', () => {
      expect(nextPhase('read_issue' as PhaseName, [])).toBe('plan-design');
      expect(nextPhase('plan-design' as PhaseName, [])).toBe('implement');
      expect(nextPhase('implement' as PhaseName, [])).toBe('validate');
    });

    it('returns null for the last phase', () => {
      expect(nextPhase('wait-merge' as PhaseName, [])).toBeNull();
    });

    it('skips phases in the skip list', () => {
      // 'compound' is the only skippable phase; skipping it should not affect nextPhase
      // since read_issue is before compound anyway
      expect(nextPhase('validate' as PhaseName, ['compound' as PhaseName])).toBe('fix-validate');
    });

    it('throws UnknownPhaseError for an unknown phase', () => {
      expect(() => nextPhase('bogus' as PhaseName, [])).toThrow(UnknownPhaseError);
    });

    it('throws InvalidSkipListError when a known phase is in the skip list', () => {
      expect(() => nextPhase('compound' as PhaseName, ['compound' as PhaseName])).toThrow(
        InvalidSkipListError,
      );
      expect(() => nextPhase('compound' as PhaseName, ['compound' as PhaseName])).toThrow(
        /skip list/,
      );
    });
  });

  describe('assertInputsAvailable', () => {
    it('passes when all required inputs are present', () => {
      expect(() =>
        assertInputsAvailable(getPhaseDefinition('implement' as PhaseName), ['plan.md']),
      ).not.toThrow();
    });

    it('throws MissingRequiredInputError naming missing required inputs', () => {
      expect(() =>
        assertInputsAvailable(getPhaseDefinition('implement' as PhaseName), ['issue.md']),
      ).toThrow(MissingRequiredInputError);
    });

    it('throws with the phase name and missing list', () => {
      expect.assertions(3);
      try {
        assertInputsAvailable(getPhaseDefinition('implement' as PhaseName), []);
      } catch (e) {
        expect(e).toBeInstanceOf(MissingRequiredInputError);
        expect((e as MissingRequiredInputError).phase).toBe('implement');
        expect((e as MissingRequiredInputError).missing).toEqual(['plan.md']);
      }
    });

    it('ignores absent optional inputs', () => {
      expect(() =>
        assertInputsAvailable(getPhaseDefinition('plan-design' as PhaseName), ['issue.md']),
      ).not.toThrow();
    });

    it('passes when no required inputs exist', () => {
      expect(() =>
        assertInputsAvailable(getPhaseDefinition('read_issue' as PhaseName), []),
      ).not.toThrow();
    });

    it('passes when required inputs have extra files present', () => {
      expect(() =>
        assertInputsAvailable(getPhaseDefinition('implement' as PhaseName), [
          'plan.md',
          'extra-file.md',
        ]),
      ).not.toThrow();
    });
  });

  describe('cross-phase consistency', () => {
    it('every required input of every phase is produced by some earlier phase', () => {
      const produced = new Set<string>();
      for (const name of CANONICAL_PHASE_ORDER) {
        const def = PHASE_DEFINITIONS[name]!;
        for (const req of def.inputs.required) {
          expect(produced).toContain(req);
        }
        for (const out of def.outputs) {
          produced.add(out);
        }
      }
    });

    it('all required inputs exist across the full chain by phase', () => {
      const produced = new Set<string>();
      for (const name of CANONICAL_PHASE_ORDER) {
        const def = PHASE_DEFINITIONS[name]!;
        const missing = def.inputs.required.filter((r) => !produced.has(r));
        expect(missing).toEqual([]);
        for (const out of def.outputs) produced.add(out);
      }
    });

    it('no two phases claim the same output except iterative review artifacts', () => {
      const allOutputs: string[] = [];
      for (const name of CANONICAL_PHASE_ORDER) {
        const def = PHASE_DEFINITIONS[name]!;
        allOutputs.push(...def.outputs);
      }
      const duplicates = Array.from(
        new Set(allOutputs.filter((item, index) => allOutputs.indexOf(item) !== index)),
      );
      expect(duplicates).toEqual(['code-review.md', 'finding-ledger.json']);
    });
  });
});
