// No captured result.json available; shape inferred from M4-05 issue spec.
import { z } from 'zod';

export const implementResultSchema = z.object({
  result: z.enum(['success', 'partial', 'failed']),
  changedFiles: z.array(z.string()),
});
export type ImplementResult = z.infer<typeof implementResultSchema>;
