import { z } from 'zod';

export const fixValidateResultSchema = z.object({
  result: z.enum(['fixed', 'cannot_fix']),
});
export type FixValidateResult = z.infer<typeof fixValidateResultSchema>;
