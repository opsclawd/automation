import { describe, it, expect } from 'vitest';
import {
  postImplementationSpecReviewResultSchema,
  isApprovedSpecReview,
  type PostImplementationSpecReviewResult,
} from '../post-implementation-spec-review.js';
import type { RequirementsLedger } from '../../../phases/requirements-ledger.js';

describe('postImplementationSpecReviewResultSchema', () => {
  it('parses valid spec review with PASS verdict', () => {
    const valid = {
      verdict: 'PASS',
      requirements_checks: [
        {
          requirement_id: 'AC-1',
          requirement: 'Spec review gate is blocking',
          result: 'PASS',
          evidence: 'Code check confirms spec-review runs and blocks',
          test_evidence: 'Unit test passes',
          counterexample_considered: 'Tested bad input permutation',
        },
      ],
      findings: [],
      summary: 'All spec requirements satisfied',
    };

    const parsed = postImplementationSpecReviewResultSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('rejects payload missing evidence in requirement check', () => {
    const invalid = {
      verdict: 'PASS',
      requirements_checks: [
        {
          requirement_id: 'AC-1',
          requirement: 'Spec review gate is blocking',
          result: 'PASS',
        },
      ],
    };

    const parsed = postImplementationSpecReviewResultSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });
});

describe('isApprovedSpecReview', () => {
  const ledger: RequirementsLedger = {
    version: 1,
    issueNumber: 1132,
    items: [
      {
        id: 'AC-1',
        category: 'acceptance_criteria',
        title: 'Must verify all inputs',
        source: 'issue.md',
        hardGate: true,
      },
      {
        id: 'REQ-DESIGN-1',
        category: 'anchored_design',
        title: 'Two review gates',
        source: 'issue.md',
        hardGate: false,
      },
    ],
  };

  it('approves when all ledger items are checked with PASS and hard-gate has counterexample_considered', () => {
    const review: PostImplementationSpecReviewResult = {
      verdict: 'PASS',
      requirements_checks: [
        {
          requirement_id: 'AC-1',
          requirement: 'Must verify all inputs',
          result: 'PASS',
          evidence: 'Verified input validation implementation',
          counterexample_considered: 'Tested adversarial bad payload',
        },
        {
          requirement_id: 'REQ-DESIGN-1',
          requirement: 'Two review gates',
          result: 'PASS',
          evidence: 'Both gates wired in executor',
        },
      ],
      findings: [],
    };

    expect(isApprovedSpecReview(review, ledger)).toBe(true);
  });

  it('rejects when verdict is FAIL', () => {
    const review: PostImplementationSpecReviewResult = {
      verdict: 'FAIL',
      requirements_checks: [
        {
          requirement_id: 'AC-1',
          requirement: 'Must verify all inputs',
          result: 'PASS',
          evidence: 'Verified',
          counterexample_considered: 'Tested adversarial',
        },
        {
          requirement_id: 'REQ-DESIGN-1',
          requirement: 'Two review gates',
          result: 'PASS',
          evidence: 'Wired',
        },
      ],
      findings: [],
    };

    expect(isApprovedSpecReview(review, ledger)).toBe(false);
  });

  it('rejects when hard-gate requirement is missing counterexample_considered', () => {
    const review: PostImplementationSpecReviewResult = {
      verdict: 'PASS',
      requirements_checks: [
        {
          requirement_id: 'AC-1',
          requirement: 'Must verify all inputs',
          result: 'PASS',
          evidence: 'Verified input validation implementation',
          // counterexample_considered missing!
        },
        {
          requirement_id: 'REQ-DESIGN-1',
          requirement: 'Two review gates',
          result: 'PASS',
          evidence: 'Both gates wired in executor',
        },
      ],
      findings: [],
    };

    expect(isApprovedSpecReview(review, ledger)).toBe(false);
  });

  it('rejects when a ledger item is omitted', () => {
    const review: PostImplementationSpecReviewResult = {
      verdict: 'PASS',
      requirements_checks: [
        {
          requirement_id: 'AC-1',
          requirement: 'Must verify all inputs',
          result: 'PASS',
          evidence: 'Verified',
          counterexample_considered: 'Tested adversarial',
        },
        // REQ-DESIGN-1 omitted!
      ],
      findings: [],
    };

    expect(isApprovedSpecReview(review, ledger)).toBe(false);
  });

  it('rejects when a ledger item is duplicated', () => {
    const review: PostImplementationSpecReviewResult = {
      verdict: 'PASS',
      requirements_checks: [
        {
          requirement_id: 'AC-1',
          requirement: 'Must verify all inputs',
          result: 'PASS',
          evidence: 'Verified 1',
          counterexample_considered: 'Tested adversarial',
        },
        {
          requirement_id: 'AC-1',
          requirement: 'Must verify all inputs (dup)',
          result: 'PASS',
          evidence: 'Verified 2',
          counterexample_considered: 'Tested adversarial',
        },
        {
          requirement_id: 'REQ-DESIGN-1',
          requirement: 'Two review gates',
          result: 'PASS',
          evidence: 'Wired',
        },
      ],
      findings: [],
    };

    expect(isApprovedSpecReview(review, ledger)).toBe(false);
  });

  it('rejects when blocking findings exist', () => {
    const review: PostImplementationSpecReviewResult = {
      verdict: 'PASS',
      requirements_checks: [
        {
          requirement_id: 'AC-1',
          requirement: 'Must verify all inputs',
          result: 'PASS',
          evidence: 'Verified',
          counterexample_considered: 'Tested adversarial',
        },
        {
          requirement_id: 'REQ-DESIGN-1',
          requirement: 'Two review gates',
          result: 'PASS',
          evidence: 'Wired',
        },
      ],
      findings: [
        {
          severity: 'high',
          evidence: 'Found defect',
          rationale: 'Risk',
          minimal_correction: 'Fix',
          blocking: true,
        },
      ],
    };

    expect(isApprovedSpecReview(review, ledger)).toBe(false);
  });
});
