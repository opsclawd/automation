// No captured result.json available; shape inferred from M4-05 issue spec.
import { z } from 'zod';

export const createPrResultSchema = z.object({
  result: z.literal('created'),
  prNumber: z.number(),
  prUrl: z.string().min(1),
});
export type CreatePrResult = z.infer<typeof createPrResultSchema>;
