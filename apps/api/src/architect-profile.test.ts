import { describe, expect, it } from 'vitest';
import { resolveArchitectProfileName } from './architect-profile.js';

describe('resolveArchitectProfileName', () => {
  it('returns the dedicated fix-review-architect profile when configured', () => {
    expect(resolveArchitectProfileName({ 'fix-review-architect': { profile: 'a' } }, {})).toBe('a');
  });

  it('prefers fix-review-architect over the planner role fallback', () => {
    expect(
      resolveArchitectProfileName(
        { 'fix-review-architect': { profile: 'a' } },
        { planner: { profile: 'b' } },
      ),
    ).toBe('a');
  });

  it('falls back to roles.planner.profile when fix-review-architect is absent', () => {
    expect(resolveArchitectProfileName({}, { planner: { profile: 'p' } })).toBe('p');
  });

  it('falls back to phaseProfiles.plan-design.profile when both are absent', () => {
    expect(resolveArchitectProfileName({ 'plan-design': { profile: 'pd' } }, {})).toBe('pd');
  });

  it('prefers roles.planner over phaseProfiles.plan-design when both are set', () => {
    expect(
      resolveArchitectProfileName(
        { 'plan-design': { profile: 'pd' } },
        { planner: { profile: 'p' } },
      ),
    ).toBe('p');
  });

  it('returns undefined when no relevant key is configured', () => {
    expect(resolveArchitectProfileName({}, {})).toBeUndefined();
  });

  it('skips a key present with profile undefined and falls through the chain', () => {
    expect(
      resolveArchitectProfileName(
        { 'fix-review-architect': { profile: undefined }, 'plan-design': { profile: 'pd' } },
        {},
      ),
    ).toBe('pd');
  });
});
