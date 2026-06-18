import { describe, it, expect } from 'vitest';
import type { PhaseName } from '@ai-sdlc/domain';
import { orderedPhases, getPhaseDefinition, assertInputsAvailable } from '../phase-definitions.js';

describe('compound skip behaviour', () => {
  it('omits compound from the order when skipped', () => {
    const names = orderedPhases(['compound' as PhaseName]).map((p) => p.name);
    expect(names).not.toContain('compound');
  });

  it('create-pr input gating passes without compound.md (optional input)', () => {
    const createPr = getPhaseDefinition('create-pr' as PhaseName);
    // compound.md is optional for create-pr; only plan.md is required
    expect(() => assertInputsAvailable(createPr, ['plan.md'])).not.toThrow();
  });
});
