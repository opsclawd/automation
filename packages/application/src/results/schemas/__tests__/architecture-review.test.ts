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
      expect(parsed.data.witness_scenarios).toEqual([]);
      expect(parsed.data.findings).toEqual([]);
    }
  });

  it('validates new architectural finding categories', () => {
    const categories = [
      'representational_completeness',
      'provenance_layering',
      'conditional_invariants',
      'witness_scenarios',
    ] as const;

    for (const category of categories) {
      const data = {
        category,
        severity: 'high',
        evidence: 'Evidence',
        rationale: 'Rationale',
        minimal_correction: 'Correction',
      };
      const parsed = architectureReviewFindingSchema.safeParse(data);
      expect(parsed.success).toBe(true);
    }
  });

  it('validates structured witness scenarios in result', () => {
    const data = {
      verdict: 'APPROVE',
      requirements_checks: [{ requirement_id: 'REQ-1', requirement: 'Req 1', result: 'PASS' }],
      witness_scenarios: [
        {
          scenario: '12s soundbed looped to 30s timeline',
          result: 'PASS',
          evidence: 'Loop representation explicitly supports 12 + 12 + 6 segments',
          counterexample: 'Partial loop tail handling verified',
        },
      ],
      findings: [],
    };
    const parsed = architectureReviewResultSchema.safeParse(data);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.witness_scenarios).toHaveLength(1);
      expect(parsed.data.witness_scenarios?.[0]?.scenario).toContain('12s soundbed');
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

  it('enforces deterministic requirements ledger disposition', () => {
    const ledger = {
      version: 1 as const,
      issueNumber: 1129,
      items: [
        {
          id: 'REQ-1',
          category: 'goal' as const,
          title: 'Representational completeness',
          source: 'issue.md',
        },
        {
          id: 'AC-1',
          category: 'acceptance_criteria' as const,
          title: 'Every ledger item must be dispositioned',
          source: 'issue.md',
        },
      ],
    };

    // 1. All ledger items dispositioned with PASS -> true
    const approvedData = {
      verdict: 'APPROVE' as const,
      requirements_checks: [
        {
          requirement_id: 'REQ-1',
          requirement: 'Representational completeness',
          result: 'PASS' as const,
        },
        {
          requirement_id: 'AC-1',
          requirement: 'Every ledger item must be dispositioned',
          result: 'PASS' as const,
        },
      ],
      findings: [],
    };
    expect(isApprovedArchitectureReview(approvedData, ledger)).toBe(true);

    // 2. One ledger item omitted from reviewer output -> false
    const omittedData = {
      verdict: 'APPROVE' as const,
      requirements_checks: [
        {
          requirement_id: 'REQ-1',
          requirement: 'Representational completeness',
          result: 'PASS' as const,
        },
      ],
      findings: [],
    };
    expect(isApprovedArchitectureReview(omittedData, ledger)).toBe(false);

    // 3. One ledger item dispositioned with FAIL -> false
    const failedData = {
      verdict: 'APPROVE' as const,
      requirements_checks: [
        {
          requirement_id: 'REQ-1',
          requirement: 'Representational completeness',
          result: 'PASS' as const,
        },
        {
          requirement_id: 'AC-1',
          requirement: 'Every ledger item must be dispositioned',
          result: 'FAIL' as const,
        },
      ],
      findings: [],
    };
    expect(isApprovedArchitectureReview(failedData, ledger)).toBe(false);

    // 4. Duplicate ledger ID -> false
    const duplicateData = {
      verdict: 'APPROVE' as const,
      requirements_checks: [
        {
          requirement_id: 'REQ-1',
          requirement: 'Representational completeness',
          result: 'PASS' as const,
        },
        {
          requirement_id: 'REQ-1',
          requirement: 'Representational completeness duplicate',
          result: 'PASS' as const,
        },
      ],
      findings: [],
    };
    expect(isApprovedArchitectureReview(duplicateData, ledger)).toBe(false);

    // 5. Title-only match without requirement_id -> false (exact ID required)
    const titleOnlyData = {
      verdict: 'APPROVE' as const,
      requirements_checks: [
        {
          requirement: 'Representational completeness',
          result: 'PASS' as const,
        },
        {
          requirement_id: 'AC-1',
          requirement: 'Every ledger item must be dispositioned',
          result: 'PASS' as const,
        },
      ],
      findings: [],
    };
    expect(isApprovedArchitectureReview(titleOnlyData, ledger)).toBe(false);
  });

  it('rejects approval when consumer requirements exist in ledger but witness_scenarios is empty', () => {
    const ledger = {
      version: 1 as const,
      issueNumber: 1129,
      items: [
        {
          id: 'CONSUMER-128-AC-1',
          category: 'consumer_requirement' as const,
          title: 'Loop soundbed 12s to 30s',
          source: 'issue #128',
        },
      ],
    };

    const data = {
      verdict: 'APPROVE' as const,
      requirements_checks: [
        {
          requirement_id: 'CONSUMER-128-AC-1',
          requirement: 'Loop soundbed 12s to 30s',
          result: 'PASS' as const,
          evidence: 'Supported by timeline model',
        },
      ],
      witness_scenarios: [],
      findings: [],
    };

    expect(isApprovedArchitectureReview(data, ledger)).toBe(false);
  });

  it('rejects approval when reviewer claims profile identity as proof of measured provenance (anti-trap)', () => {
    const ledger = {
      version: 1 as const,
      issueNumber: 1129,
      items: [
        {
          id: 'AC-1',
          category: 'acceptance_criteria' as const,
          title: 'Provide executed and measured provenance',
          source: 'issue.md',
        },
      ],
    };

    // False-positive from #129: reviewer returns APPROVE with PASS and empty findings,
    // but evidence asserts that profile identity identifies the contract
    const conflatedData = {
      verdict: 'APPROVE' as const,
      requirements_checks: [
        {
          requirement_id: 'AC-1',
          requirement: 'Provide executed and measured provenance',
          result: 'PASS' as const,
          evidence: 'The versioned assembly profile identifies the encoding contract',
        },
      ],
      witness_scenarios: [],
      findings: [],
    };

    expect(isApprovedArchitectureReview(conflatedData, ledger)).toBe(false);
  });

  it('rejects approval when any witness scenario has FAIL result', () => {
    const data = {
      verdict: 'APPROVE' as const,
      requirements_checks: [{ requirement: 'Req 1', result: 'PASS' as const }],
      witness_scenarios: [
        {
          scenario: 'Loop soundbed 12s to 30s',
          result: 'FAIL' as const,
          evidence: 'Loop representation drops tail trim',
        },
      ],
      findings: [],
    };
    expect(isApprovedArchitectureReview(data)).toBe(false);
  });
});
