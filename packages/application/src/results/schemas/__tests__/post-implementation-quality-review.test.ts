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
      ],
      summary: 'Found layer boundary violation',
    };

    const parsed = postImplementationQualityReviewResultSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
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

  it('rejects when verdict is REQUEST_CHANGES', () => {
    const review: PostImplementationQualityReviewResult = {
      verdict: 'REQUEST_CHANGES',
      findings: [],
    };

    expect(isApprovedQualityReview(review)).toBe(false);
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
});
