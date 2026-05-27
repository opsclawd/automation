// No captured result.json available; shape inferred from M4-05 issue spec.
import { z } from 'zod';

export const compoundResultSchema = z.object({
  result: z.enum(['written']),
  path: z.string().min(1),
  summary: z.string().min(1),
});
export type CompoundResult = z.infer<typeof compoundResultSchema>;
