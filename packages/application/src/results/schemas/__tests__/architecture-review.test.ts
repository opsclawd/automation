import { describe, it, expect } from 'vitest';
import {
  architectureReviewResultSchema,
  architectureReviewFindingSchema,
  isApprovedArchitectureReview,
} from '../architecture-review.js';

describe('architectureReviewResultSchema', () => {
  it('validates a successful APPROVE result with no findings', () => {
    const data = {
      verdict: 'APPROVE',
      requirements_checks: [
        {
          requirement: 'Goal: independent architecture review',
          result: 'PASS',
          evidence: 'Verified in design.md and plan.md',
        },
      ],
      findings: [],
      summary: 'Architecture meets all requirements.',
    };

    const parsed = architectureReviewResultSchema.safeParse(data);
    expect(parsed.success).toBe(true);
  });

  it('validates a REQUEST_CHANGES result with categorized findings', () => {
    const data = {
      verdict: 'REQUEST_CHANGES',
      requirements_checks: [
        {
          requirement: 'Acceptance Criteria: bounded fix budget',
          result: 'FAIL',
          evidence: 'Plan describes infinite retry loop',
        },
      ],
      findings: [
        {
          category: 'contract_conservation',
          severity: 'high',
          target: 'design.md',
          evidence: 'Field x is dropped between API and database representation',
          rationale: 'Downstream consumers require field x for audit tracking',
          minimal_correction: 'Add field x to the persistence schema',
          blocking: true,
        },
      ],
      summary: 'Blocking gaps found in contract conservation.',
    };

    const parsed = architectureReviewResultSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.findings?.[0]?.category).toBe('contract_conservation');
      expect(parsed.data.findings?.[0]?.severity).toBe('high');
      expect(parsed.data.findings?.[0]?.blocking).toBe(true);
    }
  });

  it('rejects missing mandatory fields on finding', () => {
    const finding = {
      category: 'invariant_completeness',
      severity: 'medium',
      // missing evidence, rationale, minimal_correction
    };
    const parsed = architectureReviewFindingSchema.safeParse(finding);
    expect(parsed.success).toBe(false);
  });

  it('accepts lowercase verdict aliases and defaults empty arrays', () => {
    const data = {
      verdict: 'approve',
    };
    const parsed = architectureReviewResultSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.requirements_checks).toEqual([]);
      expect(parsed.data.findings).toEqual([]);
    }
  });
});

describe('isApprovedArchitectureReview', () => {
  it('returns true when verdict is APPROVE, requirements_checks is non-empty with all PASS, and findings is empty', () => {
    const data = {
      verdict: 'APPROVE' as const,
      requirements_checks: [
        { requirement: 'Req 1', result: 'PASS' as const },
        { requirement: 'Req 2', result: 'PASS' as const },
      ],
      findings: [],
    };
    expect(isApprovedArchitectureReview(data)).toBe(true);
  });

  it('returns false when verdict is APPROVE but requirements_checks contains a FAIL', () => {
    const data = {
      verdict: 'APPROVE' as const,
      requirements_checks: [
        { requirement: 'Req 1', result: 'PASS' as const },
        { requirement: 'Req 2', result: 'FAIL' as const, evidence: 'Missing field' },
      ],
      findings: [],
    };
    expect(isApprovedArchitectureReview(data)).toBe(false);
  });

  it('returns false when verdict is APPROVE but requirements_checks is empty', () => {
    const data = {
      verdict: 'APPROVE' as const,
      requirements_checks: [],
      findings: [],
    };
    expect(isApprovedArchitectureReview(data)).toBe(false);
  });

  it('returns false when verdict is APPROVE with all PASS reqs but contains a blocking finding', () => {
    const data = {
      verdict: 'APPROVE' as const,
      requirements_checks: [{ requirement: 'Req 1', result: 'PASS' as const }],
      findings: [
        {
          severity: 'high' as const,
          evidence: 'Gap',
          rationale: 'Reason',
          minimal_correction: 'Fix',
          blocking: true,
        },
      ],
    };
    expect(isApprovedArchitectureReview(data)).toBe(false);
  });

  it('returns false when verdict is REQUEST_CHANGES', () => {
    const data = {
      verdict: 'REQUEST_CHANGES' as const,
      requirements_checks: [{ requirement: 'Req 1', result: 'PASS' as const }],
      findings: [],
    };
    expect(isApprovedArchitectureReview(data)).toBe(false);
  });
});
