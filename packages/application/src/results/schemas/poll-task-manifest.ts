import { z } from 'zod';

export const pollTaskCommentSchema = z.object({
  commentId: z.number().int(),
  path: z.string().min(1),
  line: z.number().int(),
  body: z.string(),
  reviewer: z.string(),
});

export type PollTaskComment = z.infer<typeof pollTaskCommentSchema>;

export const pollTaskEntrySchema = z.object({
  id: z.string().min(1),
  commentId: z.number().int(),
  path: z.string().min(1),
  line: z.number().int(),
  body: z.string(),
  reviewer: z.string(),
  priority: z.number().int().optional(),
  comments: z.array(pollTaskCommentSchema).optional(),
  groupKey: z.string().optional(),
});

export const pollTaskManifestSchema = z.object({
  version: z.literal(1),
  taskCount: z.number().int().min(1),
  tasks: z.array(pollTaskEntrySchema).min(1),
});

export const pollTaskBatchEntrySchema = z.object({
  id: z.string().min(1),
  groupKey: z.string().min(1),
  priority: z.number().int(),
  comments: z.array(pollTaskCommentSchema).min(1),
});

export const pollTaskManifestV2Schema = z.object({
  version: z.literal(2),
  taskCount: z.number().int().min(1),
  tasks: z.array(pollTaskBatchEntrySchema).min(1),
});

export type PollTaskEntry = z.infer<typeof pollTaskEntrySchema>;
export type PollTaskManifest = z.infer<typeof pollTaskManifestSchema>;
export type PollTaskBatchEntry = z.infer<typeof pollTaskBatchEntrySchema>;
export type PollTaskManifestV2 = z.infer<typeof pollTaskManifestV2Schema>;

export function isPollTaskManifestV2(manifest: unknown): manifest is PollTaskManifestV2 {
  if (typeof manifest !== 'object' || manifest === null) return false;
  const obj = manifest as Record<string, unknown>;
  return obj.version === 2;
}

export function selectCommentsFromManifest(
  manifest: PollTaskManifest | PollTaskManifestV2,
): PollTaskComment[] {
  if (isPollTaskManifestV2(manifest)) {
    return manifest.tasks.flatMap((task) => task.comments);
  }
  return manifest.tasks.map((task) => ({
    commentId: task.commentId,
    path: task.path,
    line: task.line,
    body: task.body,
    reviewer: task.reviewer,
  }));
}
