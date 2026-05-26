// No captured result.json available; shape inferred from M4-05 issue spec.
import { z } from 'zod';

export const planDesignResultSchema = z.object({
  result: z.enum(['ready', 'blocked']),
  summary: z.string().min(1),
});
export type PlanDesignResult = z.infer<typeof planDesignResultSchema>;
