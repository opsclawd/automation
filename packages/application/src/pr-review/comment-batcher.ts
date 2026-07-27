import type { PrReviewComment } from '@ai-sdlc/domain';

export interface CommentBatch {
  readonly path: string;
  readonly groupKey: string;
  readonly commentIds: readonly number[];
  readonly priority: number;
}

const MAX_BATCH_SIZE = 5;

function normalizePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/\/$/, '');
}

export function groupCommentsIntoBatches(comments: readonly PrReviewComment[]): CommentBatch[] {
  if (comments.length === 0) {
    return [];
  }

  const byFile = new Map<string, PrReviewComment[]>();
  for (const comment of comments) {
    const normalizedPath = normalizePath(comment.path);
    const existing = byFile.get(normalizedPath) ?? [];
    existing.push(comment);
    byFile.set(normalizedPath, existing);
  }

  const batches: CommentBatch[] = [];
  let batchPriority = 0;

  for (const [path, fileComments] of byFile) {
    for (let i = 0; i < fileComments.length; i += MAX_BATCH_SIZE) {
      batchPriority++;
      const batchComments = fileComments.slice(i, i + MAX_BATCH_SIZE);
      const commentIds = batchComments.map((c) => c.commentId);
      const firstCommentId = commentIds[0];
      const groupKey = `file:${path}:${firstCommentId}`;

      batches.push({
        path,
        groupKey,
        commentIds,
        priority: batchPriority,
      });
    }
  }

  return batches;
}

export function groupKeyForPath(path: string, baseCommentId: number): string {
  return `file:${normalizePath(path)}:${baseCommentId}`;
}
