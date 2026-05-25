// No captured result.json available; shape inferred from M4-05 issue spec.
import { z } from 'zod';

export const reviewResultSchema = z.object({
  result: z.enum(['pass', 'fail']),
  findings: z.array(
    z.object({
      severity: z.enum(['P0', 'P1', 'P2', 'P3']),
      summary: z.string().min(1),
    }),
  ),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;
