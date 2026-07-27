import { describe, expect, it } from 'vitest';
import type { SelectedPrReviewContext } from '@ai-sdlc/application';
import type { PrReviewComment } from '@ai-sdlc/domain';
import { buildPostPrReviewBatchPrompt } from '../compose.js';

function makeComment(overrides: Partial<PrReviewComment> = {}): PrReviewComment {
  return {
    commentId: 1234,
    path: 'apps/api/src/compose.ts',
    line: 50,
    body: 'Fix this logic error',
    ...overrides,
  };
}

function makeContext(overrides: Partial<SelectedPrReviewContext> = {}): SelectedPrReviewContext {
  return {
    level: 2,
    sections: [],
    includedFiles: [],
    includedHunks: [],
    includedSymbols: [],
    fullDiffIncluded: false,
    ...overrides,
  };
}

describe('buildPostPrReviewBatchPrompt', () => {
  describe('exact-id output contract', () => {
    it('batch prompt lists every comment once and requires an exact-id JSON array', () => {
      const comments = [makeComment({ commentId: 100 }), makeComment({ commentId: 200 })];
      const context = makeContext({ sections: [] });

      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace',
        comments,
        context,
        attempt: 1,
        dispositions: [],
      });

      expect(prompt).toContain('commentId: 100');
      expect(prompt).toContain('commentId: 200');
      expect(prompt).not.toContain('"commentId": "100"');
      expect(prompt).toMatch(/array.*one entry per commentId/i);
      expect(prompt).toContain('commentId: 100');
      expect(prompt).toContain('commentId: 200');
    });

    it('advertises a JSON array output contract, not a record keyed by string IDs', () => {
      const comments = [makeComment({ commentId: 1 })];
      const context = makeContext({ sections: [] });

      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace',
        comments,
        context,
        attempt: 1,
        dispositions: [],
      });

      expect(prompt).not.toMatch(/\{[\s\S]*"commentId":\s*"[^"]+"/);
      expect(prompt).toMatch(/\[[\s\S]*\{[\s\S]*commentId[\s\S]*\}/i);
    });

    it('lists each commentId only once in the prompt body', () => {
      const comments = [
        makeComment({ commentId: 1, body: 'First' }),
        makeComment({ commentId: 2, body: 'Second' }),
        makeComment({ commentId: 3, body: 'Third' }),
      ];
      const context = makeContext({ sections: [] });

      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace',
        comments,
        context,
        attempt: 1,
        dispositions: [],
      });

      const matches = prompt.match(/commentId:\s*(\d+)/g);
      expect(matches).toHaveLength(3);
    });
  });

  describe('selected-context confinement', () => {
    it('batch prompt renders bounded context provenance without an unselected full diff', () => {
      const comments = [makeComment({ commentId: 10, path: 'src/a.ts', line: 5 })];
      const context = makeContext({
        level: 2,
        fullDiffIncluded: false,
        includedFiles: ['src/a.ts'],
        includedHunks: ['hunk-1'],
        includedSymbols: ['foo'],
        sections: [
          {
            kind: 'summary',
            content: 'Diff stat: 1 file changed',
          },
          {
            kind: 'hunk',
            path: 'src/a.ts',
            lineStart: 1,
            lineEnd: 20,
            content: '@@ -1,4 +1,5 @@\n const foo = 1;',
          },
          {
            kind: 'source',
            path: 'src/a.ts',
            lineStart: 1,
            lineEnd: 15,
            content: 'const foo = 1;\nconst bar = 2;',
          },
        ],
      });

      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace',
        comments,
        context,
        attempt: 1,
        dispositions: [],
      });

      expect(prompt).toContain('includedFiles: src/a.ts');
      expect(prompt).toContain('includedHunks: hunk-1');
      expect(prompt).toContain('level: 2');
      expect(prompt).not.toContain('full-diff');
      expect(prompt).not.toContain('FULL DIFF');
    });

    it('does not include diff content outside the bounded context', () => {
      const comments = [makeComment({ commentId: 10, path: 'src/a.ts', line: 5 })];
      const context = makeContext({
        level: 1,
        fullDiffIncluded: false,
        includedFiles: ['src/a.ts'],
        sections: [
          {
            kind: 'summary',
            content: 'Diff stat: 5 files changed',
          },
          {
            kind: 'hunk',
            path: 'src/a.ts',
            content: '@@ -5,10 +5,11 @@\n relevant content',
          },
          {
            kind: 'full-diff',
            content: 'UNRELATED FILE DIFF content that should not appear',
          },
        ],
      });

      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace',
        comments,
        context,
        attempt: 1,
        dispositions: [],
      });

      expect(prompt).not.toContain('UNRELATED FILE DIFF');
    });
  });

  describe('fallback visibility', () => {
    it('batch prompt labels a selected full-diff fallback explicitly', () => {
      const comments = [makeComment({ commentId: 10 })];
      const context = makeContext({
        level: 3,
        fullDiffIncluded: true,
        fallbackReason: 'explicit_global_scope',
        sections: [
          {
            kind: 'summary',
            content: 'Diff stat: 1 file changed',
          },
          {
            kind: 'full-diff',
            content: 'diff content here',
          },
        ],
      });

      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace',
        comments,
        context,
        attempt: 3,
        dispositions: [],
      });

      expect(prompt).toContain('fallbackReason: explicit_global_scope');
      expect(prompt).toContain('FALLBACK');
    });

    it('renders no_bounded_context fallback reason when applicable', () => {
      const comments = [makeComment({ commentId: 10 })];
      const context = makeContext({
        level: 3,
        fullDiffIncluded: true,
        fallbackReason: 'no_bounded_context',
        sections: [
          {
            kind: 'summary',
            content: 'Diff stat: 1 file changed',
          },
          {
            kind: 'full-diff',
            content: 'diff content here',
          },
        ],
      });

      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace',
        comments,
        context,
        attempt: 3,
        dispositions: [],
      });

      expect(prompt).toContain('no_bounded_context');
      expect(prompt).toContain('FALLBACK');
    });
  });

  describe('feedback ownership', () => {
    it('batch prompt keeps prior feedback attached to the affected comment', () => {
      const comments = [
        makeComment({ commentId: 1, body: 'Comment A' }),
        makeComment({ commentId: 2, body: 'Comment B' }),
      ];
      const dispositions = [
        { commentId: 1, fingerprint: 'fp1', disposition: 'fixed', reason: 'Applied fix A' },
      ];

      const context = makeContext({
        level: 2,
        fullDiffIncluded: false,
        sections: [
          {
            kind: 'summary',
            content: 'Diff stat: 2 files changed',
          },
        ],
      });

      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace',
        comments,
        context,
        attempt: 2,
        dispositions,
      });

      expect(prompt).toContain('commentId: 1');
      expect(prompt).toContain('commentId: 2');
      expect(prompt).toContain('Applied fix A');
      expect(prompt).not.toContain('Applied fix B');
    });

    it('renders each comment with its own prior feedback only', () => {
      const comments = [
        makeComment({ commentId: 100, body: 'First comment' }),
        makeComment({ commentId: 200, body: 'Second comment' }),
      ];
      const dispositions = [
        { commentId: 100, fingerprint: 'fpA', disposition: 'rejected', reason: 'Reason A' },
        { commentId: 200, fingerprint: 'fpB', disposition: 'fixed', reason: 'Reason B' },
      ];

      const context = makeContext({ sections: [{ kind: 'summary', content: 'Stat' }] });

      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace',
        comments,
        context,
        attempt: 2,
        dispositions,
      });

      expect(prompt).toContain('commentId: 100');
      expect(prompt).toContain('commentId: 200');
      expect(prompt).toMatch(/commentId: 100[\s\S]*Reason A/);
      expect(prompt).toMatch(/commentId: 200[\s\S]*Reason B/);
    });
  });

  describe('no-push contract', () => {
    it('states the no-push/no-validation contract once at the top level', () => {
      const comments = [makeComment({ commentId: 1 }), makeComment({ commentId: 2 })];
      const context = makeContext({ sections: [] });

      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace',
        comments,
        context,
        attempt: 1,
        dispositions: [],
      });

      const pushMentions = (prompt.match(/Do NOT push/gi) || []).length;
      expect(pushMentions).toBeGreaterThan(0);
      expect(prompt.indexOf('Do NOT push')).toBeLessThan(prompt.indexOf('commentId: 1'));
    });

    it('includes workspace constraints in the prompt', () => {
      const comments = [makeComment({ commentId: 1 })];
      const context = makeContext({ sections: [] });

      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace',
        comments,
        context,
        attempt: 1,
        dispositions: [],
      });

      expect(prompt).toContain('WORKSPACE CONSTRAINTS');
      expect(prompt).toContain('Do NOT push');
    });
  });

  describe('section rendering in selector order', () => {
    it('renders sections in the order they appear in context.sections', () => {
      const comments = [makeComment({ commentId: 1 })];
      const context = makeContext({
        sections: [
          { kind: 'summary', content: 'FIRST_SECTION' },
          { kind: 'hunk', path: 'a.ts', content: 'SECOND_SECTION' },
          { kind: 'source', path: 'a.ts', content: 'THIRD_SECTION' },
        ],
      });

      const prompt = buildPostPrReviewBatchPrompt({
        cwd: '/workspace',
        comments,
        context,
        attempt: 1,
        dispositions: [],
      });

      const firstIdx = prompt.indexOf('FIRST_SECTION');
      const secondIdx = prompt.indexOf('SECOND_SECTION');
      const thirdIdx = prompt.indexOf('THIRD_SECTION');

      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(thirdIdx);
    });
  });
});
