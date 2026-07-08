import { describe, expect, it } from 'vitest';
import { resolveArbiterProfileName } from './arbiter-profile.js';

describe('resolveArbiterProfileName', () => {
  it('returns the dedicated arbiter profile when only arbiter is configured', () => {
    expect(resolveArbiterProfileName({ arbiter: { profile: 'a' } })).toBe('a');
  });

  it('falls back to plan-design when arbiter is not configured', () => {
    expect(resolveArbiterProfileName({ 'plan-design': { profile: 'a' } })).toBe('a');
  });

  it('falls back to fix-review when only fix-review is configured', () => {
    expect(resolveArbiterProfileName({ 'fix-review': { profile: 'a' } })).toBe('a');
  });

  it('prefers plan-design over fix-review when both are configured (legacy order preserved)', () => {
    expect(
      resolveArbiterProfileName({
        'plan-design': { profile: 'plan-design-profile' },
        'fix-review': { profile: 'fix-review-profile' },
      }),
    ).toBe('plan-design-profile');
  });

  it('returns undefined when no relevant key is configured', () => {
    expect(resolveArbiterProfileName({})).toBeUndefined();
  });

  it('skips a key present with profile undefined and falls through the chain', () => {
    expect(
      resolveArbiterProfileName({
        arbiter: { profile: undefined },
        'fix-review': { profile: 'fallback' },
      }),
    ).toBe('fallback');
  });

  it('ignores a stale phaseProfiles.arbitrate key (alias retired, not consulted)', () => {
    expect(
      resolveArbiterProfileName({
        arbitrate: { profile: 'legacy-profile' },
        'plan-design': { profile: 'plan-design-profile' },
      }),
    ).toBe('plan-design-profile');
  });
});
