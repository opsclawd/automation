import { z } from 'zod';

export const pollTaskResultSchema = z.object({
  commentId: z.number().int(),
  action: z.enum(['fixed', 'no_fix', 'blocked']),
  replyBody: z.string().min(1),
  blockedReason: z.string().optional(),
});

export type PollTaskResult = z.infer<typeof pollTaskResultSchema>;
