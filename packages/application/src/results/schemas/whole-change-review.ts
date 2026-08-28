import { z } from 'zod';

const findingPathSchema = z.string().trim().min(1);

export const wholeChangeReviewFindingSchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low', 'P0', 'P1', 'P2', 'P3']),
  files: z.array(findingPathSchema).optional().default([]),
  evidence: z.string().min(1),
  rationale: z.string().min(1),
  minimal_correction: z.string().min(1),
  blocking: z.boolean().optional(),
});

export const acceptanceCriterionCheckSchema = z.object({
  criterion: z.string().min(1),
  result: z.enum(['PASS', 'FAIL', 'pass', 'fail']),
  evidence: z.string().optional(),
});

export const wholeChangeReviewResultSchema = z.object({
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'approve', 'request_changes']),
  acceptance_criteria: z.array(acceptanceCriterionCheckSchema).default([]),
  findings: z.array(wholeChangeReviewFindingSchema).optional().default([]),
  summary: z.string().optional(),
  review_md: z.string().optional(),
});

export type WholeChangeReviewFinding = z.infer<typeof wholeChangeReviewFindingSchema>;
export type AcceptanceCriterionCheck = z.infer<typeof acceptanceCriterionCheckSchema>;
export type WholeChangeReviewResult = z.infer<typeof wholeChangeReviewResultSchema>;
