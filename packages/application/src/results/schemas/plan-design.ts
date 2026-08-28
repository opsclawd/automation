// No captured result.json available; shape inferred from M4-05 issue spec.
import { z } from 'zod';

export const planDesignResultSchema = z.object({
  result: z.enum(['ready', 'blocked']).optional(),
  summary: z.string().optional(),
  design_md: z.string().min(1, 'design_md is required and must not be empty'),
});
export type PlanDesignResult = z.infer<typeof planDesignResultSchema>;
