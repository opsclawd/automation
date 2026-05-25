// No captured result.json available; shape inferred from M4-05 issue spec.
import { z } from 'zod';

export const prReviewPollResultSchema = z.object({
  result: z.enum(['handled', 'nothing_to_handle']),
  repliesPosted: z.number().int().min(0),
});
export type PrReviewPollResult = z.infer<typeof prReviewPollResultSchema>;
