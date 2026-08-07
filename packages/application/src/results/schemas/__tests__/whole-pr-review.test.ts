import { describe, it, expect } from 'vitest';
import { wholePrReviewResultSchema } from '../whole-pr-review.js';

describe('wholePrReviewResultSchema', () => {
  it('defaults omitted review finding files to an empty array', () => {
    const result = wholePrReviewResultSchema.safeParse({
      result: 'fail',
      findings: [
        {
          severity: 'high',
          summary: 'Missing guard',
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.findings[0]?.files).toEqual([]);
    }
  });

  it('accepts finding with repository-relative files array', () => {
    const result = wholePrReviewResultSchema.safeParse({
      result: 'fail',
      findings: [
        {
          severity: 'high',
          summary: 'Missing guard',
          files: ['packages/application/src/example.ts', 'packages/application/src/types.ts'],
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.findings[0]?.files).toEqual([
        'packages/application/src/example.ts',
        'packages/application/src/types.ts',
      ]);
    }
  });

  it('rejects blank entries in files', () => {
    const resultEmpty = wholePrReviewResultSchema.safeParse({
      result: 'fail',
      findings: [
        {
          severity: 'high',
          summary: 'Missing guard',
          files: [''],
        },
      ],
    });
    expect(resultEmpty.success).toBe(false);

    const resultWhitespace = wholePrReviewResultSchema.safeParse({
      result: 'fail',
      findings: [
        {
          severity: 'high',
          summary: 'Missing guard',
          files: ['   '],
        },
      ],
    });
    expect(resultWhitespace.success).toBe(false);
  });
});
