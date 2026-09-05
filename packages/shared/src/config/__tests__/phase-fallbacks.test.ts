import { describe, it, expect } from 'vitest';
import {
  PHASE_FALLBACKS,
  LEGACY_PHASE_PROFILE_PREFERENCE,
  resolvePhaseProfileEntry,
} from '../phase-fallbacks.js';
import type { AgentConfig } from '../schema.js';

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

describe('resolvePhaseProfileEntry', () => {
  it('is frozen (no runtime mutation)', () => {
    expect(Object.isFrozen(LEGACY_PHASE_PROFILE_PREFERENCE)).toBe(true);
  });

  it('prefers the legacy post-implementation-quality-review entry over the bare quality-review entry when both exist', () => {
    const phaseProfiles: AgentConfig['phaseProfiles'] = {
      'quality-review': { role: 'critic' },
      'post-implementation-quality-review': { profile: 'sol', fallbackProfile: 'opus' },
    };
    const resolved = resolvePhaseProfileEntry(phaseProfiles, 'quality-review');
    expect(resolved).toEqual({ profile: 'sol', fallbackProfile: 'opus' });
  });

  it('prefers the legacy post-implementation-spec-review entry over the bare spec-review entry when both exist', () => {
    const phaseProfiles: AgentConfig['phaseProfiles'] = {
      'spec-review': { role: 'critic' },
      'post-implementation-spec-review': { profile: 'sol', fallbackProfile: 'opus' },
    };
    const resolved = resolvePhaseProfileEntry(phaseProfiles, 'spec-review');
    expect(resolved).toEqual({ profile: 'sol', fallbackProfile: 'opus' });
  });

  it('falls back to the bare key when the legacy key is absent', () => {
    const phaseProfiles: AgentConfig['phaseProfiles'] = {
      'quality-review': { role: 'critic' },
    };
    const resolved = resolvePhaseProfileEntry(phaseProfiles, 'quality-review');
    expect(resolved).toEqual({ role: 'critic' });
  });

  it('resolves unrelated phase ids directly, unaffected by the legacy preference table', () => {
    const phaseProfiles: AgentConfig['phaseProfiles'] = {
      'fix-review': { role: 'fixer' },
    };
    const resolved = resolvePhaseProfileEntry(phaseProfiles, 'fix-review');
    expect(resolved).toEqual({ role: 'fixer' });
  });

  it('returns undefined when neither the legacy nor bare key exists', () => {
    const phaseProfiles: AgentConfig['phaseProfiles'] = {};
    expect(resolvePhaseProfileEntry(phaseProfiles, 'quality-review')).toBeUndefined();
  });
});
