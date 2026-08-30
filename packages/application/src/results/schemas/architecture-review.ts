import { z } from 'zod';

export const architectureReviewFindingSchema = z.object({
  category: z
    .enum([
      'requirements_reconciliation',
      'contract_conservation',
      'invariant_completeness',
      'downstream_compatibility',
      'other',
    ])
    .optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'P0', 'P1', 'P2', 'P3']),
  target: z.string().optional(),
  evidence: z.string().min(1),
  rationale: z.string().min(1),
  minimal_correction: z.string().min(1),
  blocking: z.boolean().optional(),
});

export const requirementsCheckSchema = z.object({
  requirement: z.string().min(1),
  result: z.enum(['PASS', 'FAIL', 'pass', 'fail']),
  evidence: z.string().optional(),
});

export const architectureReviewResultSchema = z.object({
  verdict: z.enum([
    'APPROVE',
    'REQUEST_CHANGES',
    'approve',
    'request_changes',
    'PASS',
    'FAIL',
    'pass',
    'fail',
  ]),
  requirements_checks: z.array(requirementsCheckSchema).optional().default([]),
  findings: z.array(architectureReviewFindingSchema).optional().default([]),
  summary: z.string().optional(),
  review_md: z.string().optional(),
});

export type ArchitectureReviewFinding = z.infer<typeof architectureReviewFindingSchema>;
export type RequirementsCheck = z.infer<typeof requirementsCheckSchema>;
export type ArchitectureReviewResult = z.infer<typeof architectureReviewResultSchema>;

/**
 * Evaluates whether an architecture review result meets all criteria for approval:
 * 1. verdict is 'APPROVE' or 'PASS'
 * 2. requirements_checks is present, non-empty, and every check has result 'PASS'
 * 3. no blocking findings (blocking === true or severity in ['critical', 'high', 'P0', 'P1'])
 */
export function isApprovedArchitectureReview(review: ArchitectureReviewResult): boolean {
  const verdict = review.verdict?.toUpperCase();
  if (verdict !== 'APPROVE' && verdict !== 'PASS') {
    return false;
  }
  if (!review.requirements_checks || review.requirements_checks.length === 0) {
    return false;
  }
  const allReqsPass = review.requirements_checks.every((c) => c.result?.toUpperCase() === 'PASS');
  if (!allReqsPass) {
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
