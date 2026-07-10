import { z } from 'zod';

export const pollTaskCommentResultSchema = z.object({
  action: z.enum(['fixed', 'no_fix', 'blocked']),
  replyBody: z.string().min(1),
  blockedReason: z.string().optional(),
});

export const pollTaskResultSchema = z.record(z.string(), pollTaskCommentResultSchema);

export type PollTaskCommentResult = z.infer<typeof pollTaskCommentResultSchema>;
export type PollTaskResult = z.infer<typeof pollTaskResultSchema>;
