import { z } from 'zod';

const validationSchema = z.object({
  commands: z.array(z.string().min(1)).min(1),
  timeout: z.number().int().positive(),
});

const phasesSchema = z.object({
  skip: z.array(z.string()).default([]),
  reviewFix: z.object({ maxIterations: z.number().int().positive() }),
  implement: z.object({ maxIterations: z.number().int().positive() }),
});

const timeoutsSchema = z.object({
  readyMaxDays: z.number().int().positive(),
  invocationMaxMinutes: z.number().int().positive(),
});

export const orchestratorConfigSchema = z.object({
  validation: validationSchema,
  phases: phasesSchema,
  timeouts: timeoutsSchema,
});

export type OrchestratorConfig = z.infer<typeof orchestratorConfigSchema>;
