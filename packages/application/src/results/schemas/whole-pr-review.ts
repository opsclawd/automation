// No captured result.json available; shape inferred from M4-05 issue spec.
import { z } from 'zod';

export const wholePrReviewResultSchema = z.object({
  result: z.enum(['approve', 'changes_requested']),
  summary: z.string().min(1),
  reviewCount: z.number().int().min(1),
});
export type WholePrReviewResult = z.infer<typeof wholePrReviewResultSchema>;
