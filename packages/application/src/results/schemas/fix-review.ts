import { z } from 'zod';

const outOfScopeReasonsSchema = z
  .record(z.string().trim().min(1), z.string().trim().min(1))
  .optional()
  .default({});

export const fixReviewResultSchema = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('done_with_fixes'),
    out_of_scope_reasons: outOfScopeReasonsSchema,
  }),
  z.object({
    result: z.literal('cannot_fix'),
    reason: z.string().trim().optional(),
    out_of_scope_reasons: outOfScopeReasonsSchema,
  }),
  z.object({
    result: z.literal('done_no_fixes_needed'),
    rebuttal: z
      .string()
      .trim()
      .min(1, 'A non-empty rebuttal is required when result is done_no_fixes_needed'),
    out_of_scope_reasons: outOfScopeReasonsSchema,
  }),
]);
export type FixReviewResult = z.infer<typeof fixReviewResultSchema>;
