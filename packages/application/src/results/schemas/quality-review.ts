// No captured result.json available; shape inferred from M4-05 issue spec.
import { z } from 'zod';

export const qualityReviewFindingSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  summary: z.string().min(1),
  file: z.string().min(1).optional(),
  suggested_fix: z.string().min(1).optional(),
});

export const qualityReviewResultSchema = z.object({
  result: z.enum(['pass', 'fail']),
  findings: z.array(qualityReviewFindingSchema).optional().default([]),
});
export type QualityReviewResult = z.infer<typeof qualityReviewResultSchema>;
