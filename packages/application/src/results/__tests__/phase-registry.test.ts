import { describe, expect, it } from 'vitest';
import { PHASE_NAME_MIGRATION_MAP, PHASE_RESULT_REGISTRY } from '../phase-registry.js';

describe('PHASE_RESULT_REGISTRY', () => {
  it('contains all 9 expected phases', () => {
    const expected = [
      'implement',
      'quality-review',
      'fix-review',
      'create-pr',
      'post-pr-review',
      'spec-review',
      'whole-pr-review',
      'compound',
      'fix-validate',
    ];
    expect(Object.keys(PHASE_RESULT_REGISTRY).sort()).toEqual([...expected].sort());
  });

  it.each([
    ['implement', false],
    ['quality-review', true],
    ['fix-review', false],
    ['create-pr', false],
    ['post-pr-review', false],
    ['spec-review', true],
    ['whole-pr-review', true],
    ['compound', false],
    ['fix-validate', false],
  ])('phase %s has retrySafe=%s', (phase, expected) => {
    expect(PHASE_RESULT_REGISTRY[phase].retrySafe).toBe(expected);
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
});
