import { z } from 'zod';

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isoTimestamp = z
  .string()
  .min(1)
  .refine((s) => ISO_8601_RE.test(s) && !Number.isNaN(Date.parse(s)), {
    message: 'must be a valid ISO 8601 timestamp (e.g. 2026-05-16T12:00:00.000Z)',
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
