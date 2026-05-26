// No captured result.json available; shape inferred from M4-05 issue spec.
import { z } from 'zod';

export const planWriteResultSchema = z.object({
  result: z.enum(['ready', 'blocked']),
  tasks: z.array(
    z.object({
      title: z.string().min(1),
      description: z.string().optional(),
    }),
  ),
});
export type PlanWriteResult = z.infer<typeof planWriteResultSchema>;
