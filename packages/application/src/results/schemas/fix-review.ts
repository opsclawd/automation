import { z } from 'zod';

export const fixReviewResultSchema = z.discriminatedUnion('result', [
  z.object({
    result: z.enum(['done_with_fixes', 'cannot_fix']),
  }),
  z.object({
    result: z.literal('done_no_fixes_needed'),
    rebuttal: z
      .string()
      .trim()
      .min(1, 'A non-empty rebuttal is required when result is done_no_fixes_needed'),
  }),
]);
export type FixReviewResult = z.infer<typeof fixReviewResultSchema>;
