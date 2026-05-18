import { z } from 'zod';

const isoTimestamp = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: 'must be a parseable ISO 8601 timestamp',
  });

export const eventSchema = z.object({
  runId: z.string().min(1),
  phase: z.string().min(1).optional(),
  level: z.enum(['info', 'warn', 'error']),
  type: z.string().min(1),
  message: z.string(),
  timestamp: isoTimestamp,
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type OrchestratorEvent = z.infer<typeof eventSchema>;
