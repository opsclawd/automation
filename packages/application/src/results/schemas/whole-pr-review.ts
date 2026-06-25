import { z } from 'zod';

export const wholePrReviewResultSchema = z.object({
  result: z.enum(['pass', 'fail']),
  findings: z
    .array(
      z.object({
        severity: z.string(),
        summary: z.string().min(1),
      }),
    )
    .optional()
    .default([]),
});
export type WholePrReviewResult = z.infer<typeof wholePrReviewResultSchema>;
