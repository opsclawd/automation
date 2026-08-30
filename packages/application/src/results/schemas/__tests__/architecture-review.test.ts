import { describe, it, expect } from 'vitest';
import {
  architectureReviewResultSchema,
  architectureReviewFindingSchema,
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
