import { describe, expect, it } from 'vitest';
import { buildPostPrReviewBatchPrompt } from '../compose.js';

describe('compose-pr-review-batching', () => {
  describe('buildPostPrReviewBatchPrompt wiring', () => {
    it('renders batch prompt with multiple comments', () => {
      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace/.ai-worktrees/issue-42',
        comments: [
          {
            commentId: 9001,
            path: 'a.ts',
            line: 10,
            body: 'fix this typo',
            reviewer: 'r1',
          },
          {
            commentId: 9002,
            path: 'a.ts',
            line: 12,
            body: 'fix another typo',
            reviewer: 'r2',
          },
        ],
        context: {
          level: 1,
          sections: [],
          includedFiles: ['a.ts'],
          includedHunks: [],
          includedSymbols: [],
          fullDiffIncluded: false,
        },
        attempt: 1,
        dispositions: [],
      });

      expect(prompt).toContain('PR Review Batch Task');
      expect(prompt).toContain('commentId: 9001');
      expect(prompt).toContain('commentId: 9002');
      expect(prompt).toContain('a.ts:10');
      expect(prompt).toContain('a.ts:12');
    });

    it('includes context provenance in batch prompt', () => {
      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace/.ai-worktrees/issue-42',
        comments: [
          {
            commentId: 9001,
            path: 'a.ts',
            line: 10,
            body: 'fix this',
            reviewer: 'r1',
          },
        ],
        context: {
          level: 1,
          sections: [],
          includedFiles: ['a.ts'],
          includedHunks: ['hunk-1'],
          includedSymbols: ['MyClass'],
          fullDiffIncluded: false,
        },
        attempt: 1,
        dispositions: [],
      });

      expect(prompt).toContain('## Context Provenance');
      expect(prompt).toContain('level: 1');
      expect(prompt).toContain('includedFiles: a.ts');
    });

    it('renders full-diff context when fullDiffIncluded is true', () => {
      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace/.ai-worktrees/issue-42',
        comments: [
          {
            commentId: 9001,
            path: 'nonexistent.ts',
            line: 999,
            body: 'fix something',
            reviewer: 'r1',
          },
        ],
        context: {
          level: 2,
          sections: [
            {
              kind: 'full-diff',
              content: 'full diff content here',
            },
          ],
          includedFiles: ['other.ts'],
          includedHunks: [],
          includedSymbols: [],
          fullDiffIncluded: true,
          fallbackReason: 'no_bounded_context',
        },
        attempt: 1,
        dispositions: [],
      });

      expect(prompt).toContain('fullDiffIncluded: true');
      expect(prompt).toContain('fallbackReason: no_bounded_context');
    });
  });
});
