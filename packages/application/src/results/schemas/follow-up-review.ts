import { z } from 'zod';
import { wholeChangeReviewFindingSchema } from './whole-change-review.js';

export const followUpFindingEvaluationSchema = z.object({
  finding_id: z.string().min(1),
  resolved: z.boolean(),
  evidence: z.string().min(1),
  rationale: z.string().optional(),
});

export const followUpReviewResultSchema = z.object({
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES', 'approve', 'request_changes']),
  evaluations: z.array(followUpFindingEvaluationSchema).default([]),
  new_findings: z.array(wholeChangeReviewFindingSchema).optional().default([]),
  summary: z.string().optional(),
  review_md: z.string().optional(),
});

export type FollowUpFindingEvaluation = z.infer<typeof followUpFindingEvaluationSchema>;
export type FollowUpReviewResult = z.infer<typeof followUpReviewResultSchema>;
