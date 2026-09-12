import { describe, it, expect } from 'vitest';
import {
  postImplementationQualityReviewResultSchema,
  isApprovedQualityReview,
  type PostImplementationQualityReviewResult,
} from '../post-implementation-quality-review.js';

describe('postImplementationQualityReviewResultSchema', () => {
  it('parses valid quality review with APPROVE verdict', () => {
    const valid = {
      verdict: 'APPROVE',
      findings: [],
      summary: 'Architecture and maintainability look good',
    };

    const parsed = postImplementationQualityReviewResultSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('parses quality review with categorized findings', () => {
    const valid = {
      verdict: 'REQUEST_CHANGES',
      findings: [
        {
          category: 'architecture',
          severity: 'high',
          files: ['packages/application/src/foo.ts'],
          evidence: 'Direct import of infrastructure package',
          rationale: 'Breaks layered boundary rule in AGENTS.md',
          minimal_correction: 'Use port instead',
          blocking: true,
        },
        {
          category: 'reliability',
          severity: 'medium',
          files: ['packages/application/src/handler.ts'],
          evidence: 'Missing timeout handler',
          rationale: 'Unhandled timeout may lead to hung process',
          minimal_correction: 'Add abort signal timeout',
        },
        {
          category: 'error_handling',
          severity: 'low',
          files: ['packages/application/src/error.ts'],
          evidence: 'Swallowed error in catch block',
          rationale: 'Loss of error context',
          minimal_correction: 'Log error or rethrow',
        },
      ],
      summary: 'Found layer boundary violation and reliability risks',
    };

    const parsed = postImplementationQualityReviewResultSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it('parses valid quality review with PASS and FAIL verdict aliases', () => {
    for (const verdict of ['PASS', 'FAIL', 'pass', 'fail', 'approve', 'request_changes'] as const) {
      const parsed = postImplementationQualityReviewResultSchema.safeParse({
        verdict,
        findings: [],
      });
      expect(parsed.success).toBe(true);
    }
  });

  it('rejects unrecognized verdict values', () => {
    const parsed = postImplementationQualityReviewResultSchema.safeParse({
      verdict: 'UNKNOWN',
      findings: [],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('isApprovedQualityReview', () => {
  it('approves when verdict is APPROVE and no blocking findings exist', () => {
    const review: PostImplementationQualityReviewResult = {
      verdict: 'APPROVE',
      findings: [
        {
          severity: 'low',
          evidence: 'Minor comment suggestion',
          rationale: 'Clarity',
          minimal_correction: 'Update docstring',
          blocking: false,
        },
      ],
    };

    expect(isApprovedQualityReview(review)).toBe(true);
  });

  it('approves when verdict is PASS and no blocking findings exist', () => {
    const review: PostImplementationQualityReviewResult = {
      verdict: 'PASS',
      findings: [],
    };

    expect(isApprovedQualityReview(review)).toBe(true);
  });

  it('approves when verdict is lowercase pass or approve and no blocking findings exist', () => {
    expect(isApprovedQualityReview({ verdict: 'pass' })).toBe(true);
    expect(isApprovedQualityReview({ verdict: 'approve' })).toBe(true);
  });

  it('rejects when verdict is REQUEST_CHANGES', () => {
    const review: PostImplementationQualityReviewResult = {
      verdict: 'REQUEST_CHANGES',
      findings: [],
    };

    expect(isApprovedQualityReview(review)).toBe(false);
  });

  it('rejects when verdict is FAIL or lowercase fail', () => {
    expect(isApprovedQualityReview({ verdict: 'FAIL', findings: [] })).toBe(false);
    expect(isApprovedQualityReview({ verdict: 'fail', findings: [] })).toBe(false);
  });

  it('rejects when critical/high severity findings exist even if verdict is APPROVE', () => {
    const review: PostImplementationQualityReviewResult = {
      verdict: 'APPROVE',
      findings: [
        {
          severity: 'critical',
          evidence: 'Data integrity hazard',
          rationale: 'Corrupts state',
          minimal_correction: 'Wrap in transaction',
        },
      ],
    };

    expect(isApprovedQualityReview(review)).toBe(false);
  });

  it('rejects when critical/high severity findings exist even if verdict is PASS', () => {
    const review: PostImplementationQualityReviewResult = {
      verdict: 'PASS',
      findings: [
        {
          severity: 'high',
          evidence: 'Security risk',
          rationale: 'Unsanitized input',
          minimal_correction: 'Sanitize input',
        },
      ],
    };

    expect(isApprovedQualityReview(review)).toBe(false);
  });
});
