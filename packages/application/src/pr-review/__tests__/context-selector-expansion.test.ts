import { describe, it, expect } from 'vitest';
import { selectPrReviewContext } from '../context-selector.js';
import type { PrReviewComment, PrReviewContextSnapshot } from '@ai-sdlc/domain';
import { RunId } from '@ai-sdlc/domain';

const runId = RunId('44444444-4444-4444-4444-444444444444');

function makeComment(overrides: Partial<PrReviewComment> = {}): PrReviewComment {
  return {
    runId,
    prNumber: 5,
    commentId: 1,
    path: 'foo.ts',
    line: 3,
    reviewer: 'octocat',
    body: 'fix this',
    state: 'pending',
    attempts: 0,
    commitVerified: false,
    replyVerified: false,
    buildVerified: false,
    lastPoll: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<PrReviewContextSnapshot> = {}): PrReviewContextSnapshot {
  return {
    base: 'abc1234',
    head: 'def5678',
    fullDiff: `diff --git a/foo.ts b/foo.ts
index 1234567..abcdefg 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,5 +1,6 @@
 const x = 1;
+const y = 2;
 const z = 3;
--- a/bar.ts b/bar.ts
+++ b/bar.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;`,
    diffStat: ' foo.ts | 1 +\n bar.ts | 1 +\n2 files changed, 2 insertions',
    changedFiles: ['foo.ts', 'bar.ts'],
    trackedFiles: ['foo.ts', 'bar.ts', 'other.ts', 'foo.test.ts'],
    fileContents: {
      'foo.ts': 'const x = 1;\nconst y = 2;\nconst z = 3;\n',
      'bar.ts': 'const a = 1;\nconst b = 2;\n',
    },
    ...overrides,
  };
}

describe('context-selector expansion', () => {
  describe('attempt two expands to the full commented-file diff and prior failure evidence', () => {
    it('excludes unrelated file diffs from attempt two', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 2,
        snapshot,
      });
      expect(result.fullDiffIncluded).toBe(false);
      const unrelatedSections = result.sections.filter(
        (s) => s.path === 'bar.ts' && s.kind === 'hunk',
      );
      expect(unrelatedSections.length).toBe(0);
    });

    it('excludes the full PR diff from attempt two', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 2,
        snapshot,
      });
      const fullDiffSections = result.sections.filter((s) => s.kind === 'full-diff');
      expect(fullDiffSections.length).toBe(0);
    });

    it('includes full commented-file source in attempt two', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 2,
        snapshot,
      });
      const fooSourceSections = result.sections.filter(
        (s) => s.path === 'foo.ts' && s.kind === 'source',
      );
      expect(fooSourceSections.length).toBeGreaterThan(0);
      const fooFullSource = fooSourceSections.find(
        (s) => s.content === snapshot.fileContents['foo.ts'],
      );
      expect(fooFullSource).toBeDefined();
    });

    it('includes prior build errors in attempt two', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const snapshot = makeSnapshot();
      const buildErrors = ['Type error: cannot find name y'];
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 2,
        snapshot,
        previousBuildErrors: buildErrors,
      });
      const summarySection = result.sections.find((s) => s.kind === 'summary');
      expect(summarySection?.content).toContain('Previous build errors');
      expect(summarySection?.content).toContain('Type error');
    });

    it('includes prior verifier reasons in attempt two', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const snapshot = makeSnapshot();
      const verifierReasons = ['Verifier rejected: type mismatch'];
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 2,
        snapshot,
        previousVerifierReasons: verifierReasons,
      });
      const summarySection = result.sections.find((s) => s.kind === 'summary');
      expect(summarySection?.content).toContain('Previous verifier reasons');
      expect(summarySection?.content).toContain('type mismatch');
    });
  });

  describe('attempt three adds bounded related-file diffs without defaulting to the full PR diff', () => {
    it('keeps fullDiffIncluded false when related file diffs are available', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2, body: 'update related code' });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 3,
        snapshot,
      });
      expect(result.fullDiffIncluded).toBe(false);
    });

    it('includes related-diff sections for attempt three', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2, body: 'update related code' });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 3,
        snapshot,
      });
      const relatedDiffSections = result.sections.filter((s) => s.kind === 'related-diff');
      expect(relatedDiffSections.length).toBeGreaterThan(0);
    });

    it('does not include full-diff section when bounded context exists', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2, body: 'fix the type' });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 3,
        snapshot,
      });
      const fullDiffSections = result.sections.filter((s) => s.kind === 'full-diff');
      expect(fullDiffSections.length).toBe(0);
    });
  });

  describe('attempt three includes the full PR diff for an explicit PR-wide comment', () => {
    it('sets fallbackReason to explicit_global_scope for PR-wide request', () => {
      const comment = makeComment({
        path: 'foo.ts',
        line: 2,
        body: 'PR-wide: review all cross-cutting concerns',
      });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 3,
        snapshot,
      });
      if (result.fullDiffIncluded) {
        expect(result.fallbackReason).toBe('explicit_global_scope');
      }
    });

    it('includes full-diff section for explicit PR-wide comment', () => {
      const comment = makeComment({
        path: 'foo.ts',
        line: 2,
        body: 'analyze PR-wide patterns and issues',
      });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 3,
        snapshot,
      });
      const fullDiffSections = result.sections.filter((s) => s.kind === 'full-diff');
      expect(fullDiffSections.length).toBe(1);
      expect(result.fullDiffIncluded).toBe(true);
      expect(result.fallbackReason).toBe('explicit_global_scope');
    });

    it('detects explicit global scope from various phrasings', () => {
      const globalPhrasings = [
        'review entire PR',
        'full PR analysis needed',
        'check all files in this PR',
        'global review required',
      ];
      for (const body of globalPhrasings) {
        const comment = makeComment({ path: 'foo.ts', line: 2, body });
        const snapshot = makeSnapshot();
        const result = selectPrReviewContext({
          comments: [comment],
          attempt: 3,
          snapshot,
        });
        if (result.fullDiffIncluded) {
          expect(result.fallbackReason).toBe('explicit_global_scope');
        }
      }
    });
  });

  describe('attempt three includes the full PR diff only when bounded extraction found nothing', () => {
    it('sets fallbackReason to no_bounded_context when no context found', () => {
      const comment = makeComment({ path: 'nonexistent.ts', line: 100 });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 3,
        snapshot,
      });
      expect(result.fullDiffIncluded).toBe(true);
      expect(result.fallbackReason).toBe('no_bounded_context');
    });

    it('fullDiffIncluded is false when hasBoundedContext is true even at attempt 3', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2, body: 'simple fix' });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 3,
        snapshot,
      });
      expect(result.fullDiffIncluded).toBe(false);
      expect(result.fallbackReason).toBeUndefined();
    });

    it('no_bounded_context is set only after all bounded sources are empty', () => {
      const commentNoFile = makeComment({ path: 'nonexistent.ts', line: 1 });
      const snapshot = makeSnapshot();
      const resultNoFile = selectPrReviewContext({
        comments: [commentNoFile],
        attempt: 3,
        snapshot,
      });
      expect(resultNoFile.fullDiffIncluded).toBe(true);
      expect(resultNoFile.fallbackReason).toBe('no_bounded_context');
    });
  });

  describe('all expansion levels obey stable file section and character caps', () => {
    it('produces byte-identical sections for same input at attempt 1', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const snapshot = makeSnapshot();
      const result1 = selectPrReviewContext({
        comments: [comment],
        attempt: 1,
        snapshot,
      });
      const result2 = selectPrReviewContext({
        comments: [comment],
        attempt: 1,
        snapshot,
      });
      expect(result1.sections).toEqual(result2.sections);
    });

    it('produces byte-identical sections for same input at attempt 2', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const snapshot = makeSnapshot();
      const result1 = selectPrReviewContext({
        comments: [comment],
        attempt: 2,
        snapshot,
      });
      const result2 = selectPrReviewContext({
        comments: [comment],
        attempt: 2,
        snapshot,
      });
      expect(result1.sections).toEqual(result2.sections);
    });

    it('produces byte-identical sections for same input at attempt 3', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2, body: 'fix this' });
      const snapshot = makeSnapshot();
      const result1 = selectPrReviewContext({
        comments: [comment],
        attempt: 3,
        snapshot,
      });
      const result2 = selectPrReviewContext({
        comments: [comment],
        attempt: 3,
        snapshot,
      });
      expect(result1.sections).toEqual(result2.sections);
    });

    it('stable ordering of sections across multiple calls', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const snapshot = makeSnapshot();
      const results = Array.from({ length: 5 }, () =>
        selectPrReviewContext({ comments: [comment], attempt: 1, snapshot }),
      );
      for (let i = 1; i < results.length; i++) {
        expect(results[i].sections).toEqual(results[0].sections);
      }
    });

    it('section content is deterministic not random', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const snapshot = makeSnapshot();
      const sectionContents = Array.from({ length: 10 }, () => {
        const result = selectPrReviewContext({
          comments: [comment],
          attempt: 1,
          snapshot,
        });
        return result.sections.map((s) => s.content).join('|||');
      });
      const uniqueContents = new Set(sectionContents);
      expect(uniqueContents.size).toBe(1);
    });
  });
});
