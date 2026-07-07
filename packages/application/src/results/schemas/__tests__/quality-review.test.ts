import { describe, expect, it } from 'vitest';
import { qualityReviewResultSchema } from '../quality-review.js';

describe('qualityReviewResultSchema', () => {
  it('accepts a fail result with a finding that includes optional file and suggested_fix', () => {
    const parsed = qualityReviewResultSchema.parse({
      result: 'fail',
      findings: [
        {
          severity: 'P1',
          summary: 'X is broken',
          file: 'src/foo.ts',
          suggested_fix: 'Replace X with Y',
        },
      ],
    });
    expect(parsed.findings[0]).toMatchObject({
      severity: 'P1',
      summary: 'X is broken',
      file: 'src/foo.ts',
      suggested_fix: 'Replace Y with Y'.replace('Y', 'X'),
    });
  });

  it('still accepts a fail finding without file or suggested_fix (backward compat)', () => {
    const parsed = qualityReviewResultSchema.parse({
      result: 'fail',
      findings: [{ severity: 'P2', summary: 'Plan deviation' }],
    });
    expect(parsed.findings[0]?.file).toBeUndefined();
    expect(parsed.findings[0]?.suggested_fix).toBeUndefined();
  });

  it('still accepts a bare { "result": "pass" } (no findings key)', () => {
    const parsed = qualityReviewResultSchema.parse({ result: 'pass' });
    expect(parsed.findings).toEqual([]);
  });

  it('rejects a finding with an unknown severity', () => {
    expect(() =>
      qualityReviewResultSchema.parse({
        result: 'fail',
        findings: [{ severity: 'P9', summary: 'bad' }],
      }),
    ).toThrow();
  });

  it('rejects an empty summary', () => {
    expect(() =>
      qualityReviewResultSchema.parse({
        result: 'fail',
        findings: [{ severity: 'P0', summary: '' }],
      }),
    ).toThrow();
  });
});
