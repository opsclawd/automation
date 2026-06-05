import { z } from 'zod';

export const postPrReviewCommentSchema = z.object({
  commentId: z.number().int(),
  action: z.enum(['fixed', 'no_fix', 'blocked']),
  replyBody: z.string().min(1),
  blockedReason: z.string().optional(),
});

export const postPrReviewResultSchema = z.object({
  outcome: z.enum(['ALL_DONE', 'NO_FIXES_NEEDED', 'PARTIAL', 'BLOCKED']),
  comments: z.array(postPrReviewCommentSchema).default([]),
});

export type PostPrReviewComment = z.infer<typeof postPrReviewCommentSchema>;
export type PostPrReviewResult = z.infer<typeof postPrReviewResultSchema>;
