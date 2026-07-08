import { describe, it, expect } from 'vitest';
import { resolveArbiterProfileName } from '../arbiter-profile.js';
import { PHASE_RESULT_REGISTRY, PHASE_NAME_MIGRATION_MAP } from '@ai-sdlc/application';

describe('plan-review compose wiring', () => {
  it('resolveArbiterProfileName returns the dedicated arbiter profile', () => {
    const profile = resolveArbiterProfileName({
      arbiter: { profile: 'arbiter-claude' },
    });
    expect(profile).toBe('arbiter-claude');
  });

  it('PHASE_RESULT_REGISTRY has plan-review-arbiter entry with arbiter schema', () => {
    const entry = PHASE_RESULT_REGISTRY['plan-review-arbiter'];
    expect(entry).toBeDefined();
    expect(entry?.retrySafe).toBe(true);
  });

  it('PHASE_NAME_MIGRATION_MAP maps plan-review to null', () => {
    expect(PHASE_NAME_MIGRATION_MAP['plan-review']).toBeNull();
  });
});
