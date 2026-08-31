import { z } from 'zod';

const findingPathSchema = z.string().trim().min(1);

export const postImplementationQualityReviewFindingSchema = z.object({
  category: z
    .enum([
      'correctness',
      'architecture',
      'security',
      'data_integrity',
      'concurrency_performance',
      'maintainability',
      'scope',
      'contract_change',
      'scratch_artifact',
      'test_quality',
      'production_fidelity',
      'other',
    ])
    .optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'P0', 'P1', 'P2', 'P3']),
  files: z.array(findingPathSchema).optional().default([]),
  evidence: z.string().min(1),
  rationale: z.string().min(1),
  minimal_correction: z.string().min(1),
  blocking: z.boolean().optional(),
});

export const postImplementationQualityReviewResultSchema = z.object({
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'approve', 'request_changes']),
  findings: z.array(postImplementationQualityReviewFindingSchema).optional().default([]),
  summary: z.string().optional(),
  review_md: z.string().optional(),
});

export type PostImplementationQualityReviewFinding = z.infer<
  typeof postImplementationQualityReviewFindingSchema
>;
export type PostImplementationQualityReviewResult = z.infer<
  typeof postImplementationQualityReviewResultSchema
>;

/**
 * Evaluates whether a post-implementation quality review result meets all criteria for approval:
 * 1. verdict is 'APPROVE'
 * 2. no blocking findings (blocking === true or severity in ['critical', 'high', 'P0', 'P1'])
 */
export function isApprovedQualityReview(review: PostImplementationQualityReviewResult): boolean {
  const verdict = review.verdict?.toUpperCase();
  if (verdict !== 'APPROVE') {
    return false;
  }
  const hasBlockingFindings = review.findings?.some((f) => {
    if (f.blocking === true) return true;
    if (['critical', 'high', 'P0', 'P1'].includes(f.severity)) return true;
    return false;
  });
  if (hasBlockingFindings) {
    return false;
  }
  return true;
}
