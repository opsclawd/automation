import { z } from 'zod';

export const wholePrReviewResultSchema = z.object({
  result: z.enum(['pass', 'fail']),
  findings: z.array(
    z.object({
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      summary: z.string().min(1),
    }),
  ),
});
export type WholePrReviewResult = z.infer<typeof wholePrReviewResultSchema>;
