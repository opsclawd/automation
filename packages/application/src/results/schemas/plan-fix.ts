import { z } from 'zod';

export const planFixResultSchema = z.discriminatedUnion('verdict', [
  z.object({
    verdict: z.enum(['done_with_fixes', 'cannot_fix']),
    summary: z.string().trim().min(1, 'A non-empty summary is required'),
  }),
  z.object({
    verdict: z.literal('done_no_fixes_needed'),
    summary: z.string().trim().min(1, 'A non-empty summary is required'),
    rebuttal: z
      .string()
      .trim()
      .min(1, 'A non-empty rebuttal is required when verdict is done_no_fixes_needed'),
  }),
]);

export type PlanFixResult = z.infer<typeof planFixResultSchema>;
