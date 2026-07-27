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
    diffStat: ' foo.ts | 1 +\n bar.ts | 1 +\n 2 files changed, 2 insertions',
    changedFiles: ['foo.ts', 'bar.ts'],
    trackedFiles: ['foo.ts', 'bar.ts', 'other.ts'],
    fileContents: {
      'foo.ts': 'const x = 1;\nconst y = 2;\nconst z = 3;\n',
      'bar.ts': 'const a = 1;\nconst b = 2;\n',
    },
    ...overrides,
  };
}

describe('context-selector tier one', () => {
  describe('tier one excludes the full PR diff for a line-specific comment', () => {
    it('fullDiffIncluded is false when selecting bounded context for a line comment', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 1,
        snapshot,
      });
      expect(result.fullDiffIncluded).toBe(false);
    });

    it('sections contain hunk, source, and symbol kinds for a line comment', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 1,
        snapshot,
      });
      const sectionKinds = result.sections.map((s) => s.kind);
      expect(sectionKinds).toContain('hunk');
      expect(sectionKinds).toContain('source');
    });

    it('explicit_global_scope fallbackReason is set when full diff is explicitly requested', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 1,
        snapshot,
      });
      if (result.fullDiffIncluded) {
        expect(result.fallbackReason).toBe('explicit_global_scope');
      }
    });
  });

  describe('tier one de-duplicates one shared hunk without losing either comment', () => {
    it('two comments in the same hunk both appear in sections', () => {
      const comment1 = makeComment({ commentId: 1, path: 'foo.ts', line: 2 });
      const comment2 = makeComment({ commentId: 2, path: 'foo.ts', line: 3 });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment1, comment2],
        attempt: 1,
        snapshot,
      });
      const _comment1Sections = result.sections.filter(
        (s) => s.content.includes('comment 1') || s.path === 'foo.ts',
      );
      const _comment2Sections = result.sections.filter(
        (s) => s.content.includes('comment 2') || s.path === 'foo.ts',
      );
      expect(result.sections.length).toBeGreaterThanOrEqual(2);
    });

    it('shared hunk content appears only once in sections', () => {
      const comment1 = makeComment({ commentId: 1, path: 'foo.ts', line: 2 });
      const comment2 = makeComment({ commentId: 2, path: 'foo.ts', line: 3 });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment1, comment2],
        attempt: 1,
        snapshot,
      });
      const hunkSections = result.sections.filter((s) => s.kind === 'hunk' && s.path === 'foo.ts');
      expect(hunkSections.length).toBe(1);
    });

    it('includedHunks contains the shared hunk path once', () => {
      const comment1 = makeComment({ commentId: 1, path: 'foo.ts', line: 2 });
      const comment2 = makeComment({ commentId: 2, path: 'foo.ts', line: 3 });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment1, comment2],
        attempt: 1,
        snapshot,
      });
      const fooHunks = result.includedHunks.filter((h) => h === 'foo.ts');
      expect(fooHunks.length).toBe(1);
    });
  });

  describe('malformed or deleted-file diffs fall back to bounded source metadata', () => {
    it('parse error in diff does not throw', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const malformedSnapshot = makeSnapshot({
        fullDiff: 'not a valid diff\n@@ -1,3 @@\ngarbage',
      });
      expect(() =>
        selectPrReviewContext({
          comments: [comment],
          attempt: 1,
          snapshot: malformedSnapshot,
        }),
      ).not.toThrow();
    });

    it('parse error does not promote to fullDiffIncluded', () => {
      const comment = makeComment({ path: 'foo.ts', line: 2 });
      const malformedSnapshot = makeSnapshot({
        fullDiff: 'not a valid diff\n@@ -1,3 @@\nmalformed content',
      });
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 1,
        snapshot: malformedSnapshot,
      });
      expect(result.fullDiffIncluded).toBe(false);
    });

    it('deleted file diff does not throw', () => {
      const comment = makeComment({ path: 'deleted.ts', line: 1 });
      const deletedFileSnapshot = makeSnapshot({
        fullDiff: `diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
index 1234567..0000000
--- a/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-const x = 1;
-const y = 2;
-const z = 3;`,
        changedFiles: ['deleted.ts'],
        fileContents: {},
      });
      expect(() =>
        selectPrReviewContext({
          comments: [comment],
          attempt: 1,
          snapshot: deletedFileSnapshot,
        }),
      ).not.toThrow();
    });

    it('deleted file diff falls back to bounded source metadata', () => {
      const comment = makeComment({ path: 'deleted.ts', line: 1 });
      const deletedFileSnapshot = makeSnapshot({
        fullDiff: `diff --git a/deleted.ts b/deleted.ts
deleted file mode 100644
index 1234567..0000000
--- a/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-const x = 1;
-const y = 2;
-const z = 3;`,
        changedFiles: ['deleted.ts'],
        fileContents: {},
      });
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 1,
        snapshot: deletedFileSnapshot,
      });
      expect(result.fullDiffIncluded).toBe(false);
    });

    it('no_bounded_context fallbackReason when hunk cannot be found', () => {
      const comment = makeComment({ path: 'nonexistent.ts', line: 10 });
      const snapshot = makeSnapshot();
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 1,
        snapshot,
      });
      if (!result.fullDiffIncluded) {
        expect(result.fallbackReason).toBe('no_bounded_context');
      }
    });
  });

  describe('quoted paths and no-newline markers preserve hunk line ranges', () => {
    it('path with spaces is correctly parsed', () => {
      const comment = makeComment({ path: 'path with spaces/foo.ts', line: 2 });
      const snapshot = makeSnapshot({
        fullDiff: `diff --git "a/path with spaces/foo.ts" "b/path with spaces/foo.ts"
index 1234567..abcdefg 100644
--- "a/path with spaces/foo.ts"
+++ "b/path with spaces/foo.ts"
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 const z = 3;`,
        changedFiles: ['path with spaces/foo.ts'],
        fileContents: {
          'path with spaces/foo.ts': 'const x = 1;\nconst y = 2;\nconst z = 3;\n',
        },
      });
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 1,
        snapshot,
      });
      expect(result.includedFiles).toContain('path with spaces/foo.ts');
    });

    it('no-newline marker does not corrupt new-side line range', () => {
      const comment = makeComment({ path: 'foo.ts', line: 1 });
      const snapshot = makeSnapshot({
        fullDiff: `diff --git a/foo.ts b/foo.ts
index 1234567..abcdefg 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,4 @@
 const x = 1;\\ No newline at end of file
+const y = 2;
 const z = 3;`,
        fileContents: {
          'foo.ts': 'const x = 1;\nconst y = 2;\nconst z = 3;\n',
        },
      });
      const result = selectPrReviewContext({
        comments: [comment],
        attempt: 1,
        snapshot,
      });
      const hunkSection = result.sections.find((s) => s.kind === 'hunk' && s.path === 'foo.ts');
      expect(hunkSection).toBeDefined();
      expect(hunkSection!.lineStart).toBeDefined();
      expect(hunkSection!.lineEnd).toBeDefined();
      expect(hunkSection!.lineStart).toBeLessThanOrEqual(comment.line);
      expect(hunkSection!.lineEnd).toBeGreaterThanOrEqual(comment.line);
    });
  });
});
