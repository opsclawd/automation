import { describe, it, expect } from 'vitest';
import { PHASE_FALLBACKS } from '../phase-fallbacks.js';

describe('PHASE_FALLBACKS', () => {
  it('maps whole-pr-fix-review to fix-review', () => {
    expect(PHASE_FALLBACKS['whole-pr-fix-review']).toBe('fix-review');
  });

  it('is frozen (no runtime mutation)', () => {
    expect(Object.isFrozen(PHASE_FALLBACKS)).toBe(true);
  });

  it('maps verify-pr-review to post-pr-review', () => {
    expect(PHASE_FALLBACKS['verify-pr-review']).toBe('post-pr-review');
  });

  it('has exactly 2 entries', () => {
    expect(Object.keys(PHASE_FALLBACKS)).toHaveLength(2);
  });
});
