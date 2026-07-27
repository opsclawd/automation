import type { PrReviewComment } from '@ai-sdlc/domain';
import { parseUnifiedDiff, findHunkForLine, type ParsedUnifiedDiff } from './unified-diff.js';

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

export interface GroupCommentsIntoBatchesOptions {
  diff?: string;
  parsedDiff?: ParsedUnifiedDiff;
}

function getParsedDiff(options: GroupCommentsIntoBatchesOptions): ParsedUnifiedDiff | undefined {
  if (options.parsedDiff) {
    return options.parsedDiff;
  }
  if (options.diff !== undefined) {
    return parseUnifiedDiff(options.diff);
  }
  return undefined;
}

function buildLocalityKey(
  path: string,
  hunkIdentity: string | undefined,
  commentId: number,
): string {
  if (hunkIdentity) {
    return `hunk:${hunkIdentity}:${commentId}`;
  }
  return `file:${normalizePath(path)}:${commentId}`;
}

export function groupCommentsIntoBatches(
  comments: readonly PrReviewComment[],
  options: GroupCommentsIntoBatchesOptions = {},
): CommentBatch[] {
  if (comments.length === 0) {
    return [];
  }

  const parsedDiff = getParsedDiff(options);
  const hunks = parsedDiff?.hunks ?? new Map();

  const byLocality = new Map<string, PrReviewComment[]>();
  for (const comment of comments) {
    const normalizedPath = normalizePath(comment.path);
    const hunk = findHunkForLine(hunks, normalizedPath, comment.line);
    const hunkIdentity = hunk?.identity;
    const localityKey = hunkIdentity ? `${normalizedPath}::${hunkIdentity}` : normalizedPath;

    const existing = byLocality.get(localityKey) ?? [];
    existing.push(comment);
    byLocality.set(localityKey, existing);
  }

  const batches: CommentBatch[] = [];
  let batchPriority = 0;

  for (const localityKey of byLocality.keys()) {
    const localComments = byLocality.get(localityKey)!;
    const firstComment = localComments[0]!;
    const normalizedPath = normalizePath(firstComment.path);
    const hunk = findHunkForLine(hunks, normalizedPath, firstComment.line);
    const hunkIdentity = hunk?.identity;

    if (hunkIdentity) {
      batchPriority++;
      const commentIds = localComments.map((c) => c.commentId);
      const firstCommentId = commentIds[0]!;
      const groupKey = buildLocalityKey(normalizedPath, hunkIdentity, firstCommentId);
      batches.push({
        path: normalizedPath,
        groupKey,
        commentIds,
        priority: batchPriority,
      });
    } else {
      for (let i = 0; i < localComments.length; i += MAX_BATCH_SIZE) {
        batchPriority++;
        const batchComments = localComments.slice(i, i + MAX_BATCH_SIZE);
        const commentIds = batchComments.map((c) => c.commentId);
        const firstCommentId = commentIds[0]!;
        const groupKey = buildLocalityKey(normalizedPath, hunkIdentity, firstCommentId);
        batches.push({
          path: normalizedPath,
          groupKey,
          commentIds,
          priority: batchPriority,
        });
      }
    }
  }

  return batches;
}

export function groupKeyForPath(path: string, baseCommentId: number): string {
  return `file:${normalizePath(path)}:${baseCommentId}`;
}
