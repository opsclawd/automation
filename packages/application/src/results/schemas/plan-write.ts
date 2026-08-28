// No captured result.json available; shape inferred from M4-05 issue spec.
import { z } from 'zod';

export const planWriteResultSchema = z.object({
  result: z.enum(['ready', 'blocked']).optional(),
  plan_md: z.string().min(1, 'plan_md is required and must not be empty'),
  task_manifest: z.union([z.record(z.unknown()), z.string()]).optional(),
});
export type PlanWriteResult = z.infer<typeof planWriteResultSchema>;
