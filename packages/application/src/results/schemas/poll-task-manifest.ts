import { z } from 'zod';

export const pollCommentEntrySchema = z.object({
  commentId: z.number().int(),
  path: z.string().min(1),
  line: z.number().int(),
  body: z.string(),
  reviewer: z.string(),
});

export const pollTaskEntrySchema = z.object({
  id: z.string().min(1),
  comments: z.array(pollCommentEntrySchema).min(1),
  priority: z.number().int(),
});

export const pollTaskManifestSchema = z.object({
  version: z.literal(1),
  taskCount: z.number().int().min(1),
  tasks: z.array(pollTaskEntrySchema).min(1),
});

export type PollCommentEntry = z.infer<typeof pollCommentEntrySchema>;
export type PollTaskEntry = z.infer<typeof pollTaskEntrySchema>;
export type PollTaskManifest = z.infer<typeof pollTaskManifestSchema>;
