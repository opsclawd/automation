import { z } from 'zod';

const findingPathSchema = z.string().trim().min(1);

export const wholePrReviewResultSchema = z.object({
  result: z.enum(['pass', 'fail']),
  findings: z
    .array(
      z.object({
        severity: z.string(),
        summary: z.string().min(1),
        files: z.array(findingPathSchema).optional().default([]),
      }),
    )
    .optional()
    .default([]),
});
export type WholePrReviewResult = z.infer<typeof wholePrReviewResultSchema>;
