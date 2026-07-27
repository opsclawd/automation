import { describe, it, expect } from 'vitest';
import type { PrReviewComment } from '@ai-sdlc/domain';
import { createPrReviewComment, RunId } from '@ai-sdlc/domain';
import { groupCommentsIntoBatches, type CommentBatch } from '../comment-batcher.js';

const runId = RunId('44444444-4444-4444-4444-444444444444');

function makeComment(
  overrides: Partial<PrReviewComment> & { commentId: number; path: string; line: number },
): PrReviewComment {
  return createPrReviewComment({
    runId,
    prNumber: 5,
    commentId: overrides.commentId,
    path: overrides.path,
    line: overrides.line,
    reviewer: 'octocat',
    body: `Comment ${overrides.commentId}`,
    now: new Date(),
    ...overrides,
  } as Parameters<typeof createPrReviewComment>[0]);
}

function groupComments(comments: PrReviewComment[]): CommentBatch[] {
  return groupCommentsIntoBatches(comments);
}

describe('comment-batcher', () => {
  describe('comments in one hunk form one stable batch', () => {
    it('two same-file comments in the same hunk form one batch', () => {
      const comments = [
        makeComment({ commentId: 1, path: 'a.ts', line: 10 }),
        makeComment({ commentId: 2, path: 'a.ts', line: 15 }),
      ];
      const batches = groupComments(comments);
      expect(batches).toHaveLength(1);
      expect(batches[0].commentIds).toEqual([1, 2]);
    });

    it('three same-file comments in the same hunk form one batch in input order', () => {
      const comments = [
        makeComment({ commentId: 3, path: 'b.ts', line: 20 }),
        makeComment({ commentId: 1, path: 'b.ts', line: 25 }),
        makeComment({ commentId: 2, path: 'b.ts', line: 30 }),
      ];
      const batches = groupComments(comments);
      expect(batches).toHaveLength(1);
      expect(batches[0].commentIds).toEqual([3, 1, 2]);
    });

    it('batch preserves input priority order', () => {
      const comments = [
        makeComment({ commentId: 10, path: 'c.ts', line: 5 }),
        makeComment({ commentId: 5, path: 'c.ts', line: 8 }),
        makeComment({ commentId: 20, path: 'c.ts', line: 12 }),
      ];
      const batches = groupComments(comments);
      expect(batches).toHaveLength(1);
      expect(batches[0].commentIds).toEqual([10, 5, 20]);
    });
  });

  describe('comments in separate files remain separate batches', () => {
    it('different files never share a batch', () => {
      const comments = [
        makeComment({ commentId: 1, path: 'a.ts', line: 10 }),
        makeComment({ commentId: 2, path: 'b.ts', line: 10 }),
      ];
      const batches = groupComments(comments);
      expect(batches).toHaveLength(2);
      const batchPaths = batches.map((b) => b.path);
      expect(batchPaths).toContain('a.ts');
      expect(batchPaths).toContain('b.ts');
    });

    it('three comments in two files form two batches', () => {
      const comments = [
        makeComment({ commentId: 1, path: 'x.ts', line: 5 }),
        makeComment({ commentId: 2, path: 'y.ts', line: 10 }),
        makeComment({ commentId: 3, path: 'x.ts', line: 20 }),
      ];
      const batches = groupComments(comments);
      expect(batches).toHaveLength(2);
      const xBatch = batches.find((b) => b.path === 'x.ts');
      const yBatch = batches.find((b) => b.path === 'y.ts');
      expect(xBatch?.commentIds).toEqual([1, 3]);
      expect(yBatch?.commentIds).toEqual([2]);
    });
  });

  describe('same-file comments beyond the cap split deterministically', () => {
    it('six comments in same file split into batches of five and one', () => {
      const comments = [
        makeComment({ commentId: 1, path: 'a.ts', line: 5 }),
        makeComment({ commentId: 2, path: 'a.ts', line: 10 }),
        makeComment({ commentId: 3, path: 'a.ts', line: 15 }),
        makeComment({ commentId: 4, path: 'a.ts', line: 20 }),
        makeComment({ commentId: 5, path: 'a.ts', line: 25 }),
        makeComment({ commentId: 6, path: 'a.ts', line: 30 }),
      ];
      const batches = groupComments(comments);
      expect(batches).toHaveLength(2);
      expect(batches[0].commentIds).toHaveLength(5);
      expect(batches[1].commentIds).toHaveLength(1);
      expect(batches[0].commentIds).toEqual([1, 2, 3, 4, 5]);
      expect(batches[1].commentIds).toEqual([6]);
    });

    it('seven comments in same file split into batches of five and two', () => {
      const comments = [
        makeComment({ commentId: 1, path: 'a.ts', line: 5 }),
        makeComment({ commentId: 2, path: 'a.ts', line: 10 }),
        makeComment({ commentId: 3, path: 'a.ts', line: 15 }),
        makeComment({ commentId: 4, path: 'a.ts', line: 20 }),
        makeComment({ commentId: 5, path: 'a.ts', line: 25 }),
        makeComment({ commentId: 6, path: 'a.ts', line: 30 }),
        makeComment({ commentId: 7, path: 'a.ts', line: 35 }),
      ];
      const batches = groupComments(comments);
      expect(batches).toHaveLength(2);
      expect(batches[0].commentIds).toHaveLength(5);
      expect(batches[1].commentIds).toHaveLength(2);
      expect(batches[0].commentIds).toEqual([1, 2, 3, 4, 5]);
      expect(batches[1].commentIds).toEqual([6, 7]);
    });

    it('eleven comments split into batches of 5, 5, 1', () => {
      const comments = Array.from({ length: 11 }, (_, i) =>
        makeComment({ commentId: i + 1, path: 'a.ts', line: (i + 1) * 5 }),
      );
      const batches = groupComments(comments);
      expect(batches).toHaveLength(3);
      expect(batches[0].commentIds).toHaveLength(5);
      expect(batches[1].commentIds).toHaveLength(5);
      expect(batches[2].commentIds).toHaveLength(1);
    });

    it('batch cap is exactly five - no batch exceeds five', () => {
      const comments = Array.from({ length: 20 }, (_, i) =>
        makeComment({ commentId: i + 1, path: 'a.ts', line: (i + 1) * 5 }),
      );
      const batches = groupComments(comments);
      for (const batch of batches) {
        expect(batch.commentIds.length).toBeLessThanOrEqual(5);
      }
    });

    it('splitting is deterministic across multiple calls', () => {
      const comments = Array.from({ length: 7 }, (_, i) =>
        makeComment({ commentId: i + 1, path: 'a.ts', line: (i + 1) * 10 }),
      );
      const firstRun = groupComments([...comments]);
      const secondRun = groupComments([...comments]);
      expect(firstRun).toEqual(secondRun);
    });
  });

  describe('cross-file isolation', () => {
    it('files are never mixed across batches', () => {
      const comments = [
        makeComment({ commentId: 1, path: 'a.ts', line: 5 }),
        makeComment({ commentId: 2, path: 'b.ts', line: 5 }),
        makeComment({ commentId: 3, path: 'c.ts', line: 5 }),
        makeComment({ commentId: 4, path: 'a.ts', line: 15 }),
        makeComment({ commentId: 5, path: 'b.ts', line: 15 }),
      ];
      const batches = groupComments(comments);
      const allPaths = new Set(batches.map((b) => b.path));
      expect(allPaths.size).toBe(3);
      for (const batch of batches) {
        expect(batch.commentIds.length).toBeLessThanOrEqual(5);
      }
    });
  });
});
