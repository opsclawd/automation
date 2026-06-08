import { describe, it, expect } from 'vitest';
import { PHASE_FALLBACKS } from '../phase-fallbacks.js';

describe('PHASE_FALLBACKS', () => {
  it('maps whole-pr-fix-review to fix-review', () => {
    expect(PHASE_FALLBACKS['whole-pr-fix-review']).toBe('fix-review');
  });

  it('is frozen (no runtime mutation)', () => {
    expect(Object.isFrozen(PHASE_FALLBACKS)).toBe(true);
  });

  it('has exactly one entry', () => {
    expect(Object.keys(PHASE_FALLBACKS)).toHaveLength(1);
  });
});
