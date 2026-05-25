// No captured result.json available; shape inferred from M4-05 issue spec.
import { z } from 'zod';

export const fixReviewResultSchema = z.object({
  result: z.enum(['done_with_fixes', 'done_no_fixes_needed', 'cannot_fix']),
});
export type FixReviewResult = z.infer<typeof fixReviewResultSchema>;
