// No captured result.json available; shape inferred from M4-05 issue spec.
import { z } from 'zod';

export const createPrResultSchema = z.object({
  result: z.literal('created'),
  prNumber: z.number().int().positive(),
  prUrl: z.string().url(),
});
export type CreatePrResult = z.infer<typeof createPrResultSchema>;
