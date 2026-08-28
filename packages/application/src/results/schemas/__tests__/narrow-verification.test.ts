import { describe, it, expect } from 'vitest';
import { narrowVerificationResultSchema, findingEvaluationSchema } from '../narrow-verification.js';

describe('narrowVerificationResultSchema', () => {
  it('parses valid PASS result with evaluations and no regressions', () => {
    const valid = {
      verdict: 'PASS',
      findings_evaluations: [
        {
          finding: 'Null check missing in review-fix handler',
          resolved: true,
          evidence: 'Added optional chaining and null check in review-fix.ts:42',
        },
      ],
      obvious_regressions: [],
      summary: 'All findings verified resolved without regressions.',
    };

    const parsed = narrowVerificationResultSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.verdict).toBe('PASS');
      expect(parsed.data.findings_evaluations).toHaveLength(1);
      expect(parsed.data.findings_evaluations[0]?.resolved).toBe(true);
      expect(parsed.data.obvious_regressions).toHaveLength(0);
    }
  });

  it('parses valid FAIL result with unresolved findings and obvious regressions', () => {
    const validFail = {
      verdict: 'FAIL',
      findings_evaluations: [
        {
          finding: 'Null check missing',
          resolved: false,
          evidence: 'Code still accesses prop directly without check',
          rationale: 'TypeError still thrown on undefined',
        },
      ],
      obvious_regressions: ['Broken build in tests/handler.test.ts'],
      summary: 'Finding not resolved and test broken',
    };

    const parsed = narrowVerificationResultSchema.safeParse(validFail);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.verdict).toBe('FAIL');
      expect(parsed.data.findings_evaluations[0]?.resolved).toBe(false);
      expect(parsed.data.obvious_regressions).toContain('Broken build in tests/handler.test.ts');
    }
  });

  it('rejects invalid verdicts', () => {
    const invalid = {
      verdict: 'UNKNOWN_VERDICT',
      findings_evaluations: [],
    };

    const parsed = narrowVerificationResultSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });

  it('rejects evaluations with missing evidence', () => {
    const invalidEval = {
      finding: 'Missing test',
      resolved: true,
      evidence: '',
    };

    const parsed = findingEvaluationSchema.safeParse(invalidEval);
    expect(parsed.success).toBe(false);
  });
});
