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
});
