import { describe, it, expect } from 'vitest';
import { fixReviewResultSchema } from '../fix-review.js';

describe('fixReviewResultSchema', () => {
  it('accepts done_with_fixes', () => {
    const result = fixReviewResultSchema.safeParse({ result: 'done_with_fixes' });
    expect(result.success).toBe(true);
  });

  it('accepts cannot_fix', () => {
    const result = fixReviewResultSchema.safeParse({ result: 'cannot_fix' });
    expect(result.success).toBe(true);
  });

  it('accepts done_no_fixes_needed with non-empty rebuttal', () => {
    const result = fixReviewResultSchema.safeParse({
      result: 'done_no_fixes_needed',
      rebuttal: 'The finding is a false positive — named exports satisfy the constraint.',
    });
    expect(result.success).toBe(true);
  });

  it('rejects done_no_fixes_needed without rebuttal', () => {
    const result = fixReviewResultSchema.safeParse({ result: 'done_no_fixes_needed' });
    expect(result.success).toBe(false);
  });

  it('rejects done_no_fixes_needed with empty rebuttal', () => {
    const result = fixReviewResultSchema.safeParse({
      result: 'done_no_fixes_needed',
      rebuttal: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects done_no_fixes_needed with whitespace-only rebuttal', () => {
    const result = fixReviewResultSchema.safeParse({
      result: 'done_no_fixes_needed',
      rebuttal: '   ',
    });
    expect(result.success).toBe(false);
  });

  it('normalizes omitted out_of_scope_reasons to an empty object', () => {
    const result = fixReviewResultSchema.safeParse({ result: 'done_with_fixes' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.out_of_scope_reasons).toEqual({});
    }
  });

  it('accepts valid out_of_scope_reasons map', () => {
    const result = fixReviewResultSchema.safeParse({
      result: 'done_with_fixes',
      out_of_scope_reasons: {
        'packages/api/src/caller.test.ts':
          'The public behavior changed, so its regression test had to change.',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.out_of_scope_reasons).toEqual({
        'packages/api/src/caller.test.ts':
          'The public behavior changed, so its regression test had to change.',
      });
    }
  });

  it('rejects blank out-of-scope reason keys and values', () => {
    const emptyValue = fixReviewResultSchema.safeParse({
      result: 'done_with_fixes',
      out_of_scope_reasons: {
        'packages/api/src/caller.test.ts': '',
      },
    });
    expect(emptyValue.success).toBe(false);

    const whitespaceValue = fixReviewResultSchema.safeParse({
      result: 'done_with_fixes',
      out_of_scope_reasons: {
        'packages/api/src/caller.test.ts': '   ',
      },
    });
    expect(whitespaceValue.success).toBe(false);

    const emptyKey = fixReviewResultSchema.safeParse({
      result: 'done_with_fixes',
      out_of_scope_reasons: {
        '': 'Valid reason for blank path',
      },
    });
    expect(emptyKey.success).toBe(false);

    const whitespaceKey = fixReviewResultSchema.safeParse({
      result: 'done_with_fixes',
      out_of_scope_reasons: {
        '   ': 'Valid reason for whitespace path',
      },
    });
    expect(whitespaceKey.success).toBe(false);
  });
});
