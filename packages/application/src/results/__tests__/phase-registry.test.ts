import { describe, expect, it } from 'vitest';
import {
  PHASE_NAME_MIGRATION_MAP,
  PHASE_RESULT_REGISTRY,
  getPhaseResultMeta,
  normalizePhaseId,
} from '../phase-registry.js';

describe('normalizePhaseId', () => {
  it('normalizes iteration-suffixed phase IDs', () => {
    expect(normalizePhaseId('fix-validate-1')).toBe('fix-validate');
    expect(normalizePhaseId('fix-validate-12')).toBe('fix-validate');
    expect(normalizePhaseId('implement')).toBe('implement');
  });

  it('normalizes task-suffixed and loop-suffixed historical phase IDs', () => {
    expect(normalizePhaseId('implement-task-1')).toBe('implement');
    expect(normalizePhaseId('implement-task-10')).toBe('implement');
    expect(normalizePhaseId('quality-review-task-2')).toBe('quality-review');
    expect(normalizePhaseId('spec-review-task-3')).toBe('spec-review');
    expect(normalizePhaseId('arbiter-task-1')).toBe('arbiter');
    expect(normalizePhaseId('fix-review-loop-1')).toBe('fix-review');
    expect(normalizePhaseId('fix-review-task-1')).toBe('fix-review');
    expect(normalizePhaseId('fix-review-task-F1')).toBe('fix-review');
    expect(normalizePhaseId('fix-review-task-task-1')).toBe('fix-review');
    expect(normalizePhaseId('fix-validate-loop-2')).toBe('fix-validate');
    expect(normalizePhaseId('plan-review-1')).toBe('plan-review');
    expect(normalizePhaseId('plan-fix-1')).toBe('plan-fix');
  });
});

describe('PHASE_RESULT_REGISTRY', () => {
  it('contains all expected phases in registry', () => {
    const expected = [
      'implement',
      'architecture-review',
      'plan-design',
      'quality-review',
      'fix-review',
      'initial-review',
      'follow-up-review',
      'create-pr',
      'post-pr-review',
      'spec-review',
      'whole-pr-review',
      'whole-change-review',
      'narrow-verification',
      'compound',
      'fix-validate',
      'arbiter',
      'plan-review-arbiter',
      'implement-final-review-arbiter',
      'plan-fix',
    ];
    expect(Object.keys(PHASE_RESULT_REGISTRY).sort()).toEqual([...expected].sort());
  });

  it.each([
    'implement',
    'architecture-review',
    'plan-design',
    'quality-review',
    'fix-review',
    'create-pr',
    'post-pr-review',
    'spec-review',
    'whole-pr-review',
    'whole-change-review',
    'narrow-verification',
    'compound',
    'fix-validate',
    'arbiter',
    'plan-review-arbiter',
    'implement-final-review-arbiter',
    'plan-fix',
  ])('phase %s has a schemaContractText string', (phase) => {
    expect(typeof PHASE_RESULT_REGISTRY[phase].schemaContractText).toBe('string');
    expect(PHASE_RESULT_REGISTRY[phase].schemaContractText.length).toBeGreaterThan(0);
  });

  it('each phase has a valid zod schema', () => {
    for (const [, meta] of Object.entries(PHASE_RESULT_REGISTRY)) {
      expect(meta.schema).toBeDefined();
      const parseResult = meta.schema.safeParse({});
      // At minimum, schema exists and doesn't throw
      expect(parseResult.success).toBe(false); // empty object should fail validation
    }
  });

  it('does not contain old phase names (review, pr-review-poll)', () => {
    expect(PHASE_RESULT_REGISTRY).not.toHaveProperty('review');
    expect(PHASE_RESULT_REGISTRY).not.toHaveProperty('pr-review-poll');
  });
});

describe('PHASE_NAME_MIGRATION_MAP', () => {
  it('maps review-fix to null (no result.json produced)', () => {
    expect(PHASE_NAME_MIGRATION_MAP['review-fix']).toBeNull();
  });

  it('does not alias review-fix to fix-review', () => {
    expect(PHASE_NAME_MIGRATION_MAP['review-fix']).not.toBe('fix-review');
  });

  it('keeps fix-review and whole-pr-review entries in PHASE_RESULT_REGISTRY as loop-internal schemas', () => {
    expect(PHASE_RESULT_REGISTRY).toHaveProperty('fix-review');
    expect(PHASE_RESULT_REGISTRY).toHaveProperty('whole-pr-review');
  });

  it('maps historical non-result-producing phases to null', () => {
    expect(PHASE_NAME_MIGRATION_MAP['plan-review']).toBeNull();
    expect(PHASE_NAME_MIGRATION_MAP['plan-write']).toBeNull();
    expect(PHASE_NAME_MIGRATION_MAP['post-pr-review']).toBeNull();
    expect(PHASE_NAME_MIGRATION_MAP['validate']).toBeNull();
    expect(PHASE_NAME_MIGRATION_MAP['read_issue']).toBeNull();
    expect(PHASE_NAME_MIGRATION_MAP['wait-merge']).toBeNull();
    expect(PHASE_NAME_MIGRATION_MAP['verify']).toBeNull();
    expect(PHASE_NAME_MIGRATION_MAP['review']).toBeNull();
  });

  it('maps aliases and result-producing phases correctly', () => {
    expect(PHASE_NAME_MIGRATION_MAP['pr-review-poll']).toBe('post-pr-review');
    expect(PHASE_NAME_MIGRATION_MAP['spec-review']).toBe('spec-review');
    expect(PHASE_NAME_MIGRATION_MAP['quality-review']).toBe('quality-review');
    expect(PHASE_NAME_MIGRATION_MAP['whole-pr-review']).toBe('whole-pr-review');
    expect(PHASE_NAME_MIGRATION_MAP['initial-review']).toBe('initial-review');
    expect(PHASE_NAME_MIGRATION_MAP['fix-review']).toBe('fix-review');
    expect(PHASE_NAME_MIGRATION_MAP['follow-up-review']).toBe('follow-up-review');
    expect(PHASE_NAME_MIGRATION_MAP['fix-validate']).toBe('fix-validate');
    expect(PHASE_NAME_MIGRATION_MAP['plan-fix']).toBe('plan-fix');
    expect(PHASE_NAME_MIGRATION_MAP['arbiter']).toBe('arbiter');
  });
});

describe('getPhaseResultMeta', () => {
  it('resolves schemas through aliases and migration mapping', () => {
    // pr-review-poll aliases to post-pr-review
    const prPollMeta = getPhaseResultMeta('pr-review-poll');
    expect(prPollMeta).toBeDefined();
    expect(prPollMeta).toBe(PHASE_RESULT_REGISTRY['post-pr-review']);

    // task-suffixed phase IDs normalize to base phase
    const implTaskMeta = getPhaseResultMeta('implement-task-1');
    expect(implTaskMeta).toBeDefined();
    expect(implTaskMeta).toBe(PHASE_RESULT_REGISTRY['implement']);

    const qualityTaskMeta = getPhaseResultMeta('quality-review-task-2');
    expect(qualityTaskMeta).toBeDefined();
    expect(qualityTaskMeta).toBe(PHASE_RESULT_REGISTRY['quality-review']);

    const specTaskMeta = getPhaseResultMeta('spec-review-task-3');
    expect(specTaskMeta).toBeDefined();
    expect(specTaskMeta).toBe(PHASE_RESULT_REGISTRY['spec-review']);
  });

  it('returns undefined for non-result-producing phases', () => {
    expect(getPhaseResultMeta('plan-review')).toBeUndefined();
    expect(getPhaseResultMeta('plan-write')).toBeUndefined();
    expect(getPhaseResultMeta('review-fix')).toBeUndefined();
    expect(getPhaseResultMeta('verify')).toBeUndefined();
    expect(getPhaseResultMeta('review')).toBeUndefined();
    expect(getPhaseResultMeta('unknown-phase')).toBeUndefined();
  });
});
