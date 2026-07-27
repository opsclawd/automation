import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../unified-diff.js';

describe('parseUnifiedDiff', () => {
  it('parses a simple add-only hunk', () => {
    const diff = `--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 const z = 3;`;
    const result = parseUnifiedDiff(diff);
    expect(result.hunks.size).toBe(1);
    const hunkList = result.hunks.get('foo.ts');
    expect(hunkList).toBeDefined();
    expect(hunkList!.length).toBe(1);
    const hunk = hunkList![0];
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(3);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(4);
    expect(hunk.body).toContain('+const y = 2');
  });

  it('parses a simple modify hunk', () => {
    const diff = `--- a/foo.ts
+++ b/foo.ts
@@ -1,4 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 3;`;
    const result = parseUnifiedDiff(diff);
    expect(result.hunks.size).toBe(1);
    const hunkList = result.hunks.get('foo.ts');
    expect(hunkList).toBeDefined();
    expect(hunkList!.length).toBe(1);
    const hunk = hunkList![0];
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(4);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(4);
  });

  it('parses a deleted file diff', () => {
    const diff = `--- a/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-const x = 1;
-const y = 2;
-const z = 3;`;
    const result = parseUnifiedDiff(diff);
    expect(result.hunks.size).toBe(1);
    const hunkList = result.hunks.get('deleted.ts');
    expect(hunkList).toBeDefined();
    expect(hunkList!.length).toBe(1);
    const hunk = hunkList![0];
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldLines).toBe(3);
    expect(hunk.newStart).toBe(0);
    expect(hunk.newLines).toBe(0);
    expect(hunk.isDeleted).toBe(true);
  });

  it('parses quoted paths with spaces', () => {
    const diff = `--- "a/path with spaces/foo.ts"
+++ "b/path with spaces/foo.ts"
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 const z = 3;`;
    const result = parseUnifiedDiff(diff);
    expect(result.hunks.size).toBe(1);
    const hunkList = result.hunks.get('path with spaces/foo.ts');
    expect(hunkList).toBeDefined();
    expect(hunkList!.length).toBe(1);
    const hunk = hunkList![0];
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(4);
  });

  it('preserves no-newline marker in body', () => {
    const diff = `--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,4 @@
 const x = 1;\\ No newline at end of file
+const y = 2;
 const z = 3;`;
    const result = parseUnifiedDiff(diff);
    const hunkList = result.hunks.get('foo.ts');
    expect(hunkList).toBeDefined();
    expect(hunkList!.length).toBe(1);
    const hunk = hunkList![0];
    expect(hunk.body).toContain('\\ No newline at end of file');
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(4);
  });

  it('parses diff stat and changed files', () => {
    const diff = `diff --git a/foo.ts b/foo.ts
index 1234567..abcdefg 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 const z = 3;

diff --git a/bar.ts b/bar.ts
index 7654321..fedcba9 100644
--- a/bar.ts
+++ b/bar.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;`;
    const result = parseUnifiedDiff(diff);
    expect(result.files).toContain('foo.ts');
    expect(result.files).toContain('bar.ts');
    expect(result.diffStat).toContain('foo.ts');
    expect(result.diffStat).toContain('bar.ts');
  });

  it('handles malformed diff without throwing', () => {
    const malformedDiff = `not a valid diff
this is garbage
@@ -1,3 @@`;
    const result = parseUnifiedDiff(malformedDiff);
    expect(result.hunks.size).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.parseError).toBeDefined();
  });

  it('handles empty diff without throwing', () => {
    const emptyDiff = '';
    const result = parseUnifiedDiff(emptyDiff);
    expect(result.hunks.size).toBe(0);
    expect(result.files).toEqual([]);
  });

  it('parses new file diff', () => {
    const diff = `--- /dev/null
+++ b/newfile.ts
@@ -0,0 +1,3 @@
+const x = 1;
+const y = 2;
+const z = 3;`;
    const result = parseUnifiedDiff(diff);
    expect(result.hunks.size).toBe(1);
    const hunkList = result.hunks.get('newfile.ts');
    expect(hunkList).toBeDefined();
    expect(hunkList!.length).toBe(1);
    const hunk = hunkList![0];
    expect(hunk.oldStart).toBe(0);
    expect(hunk.oldLines).toBe(0);
    expect(hunk.newStart).toBe(1);
    expect(hunk.newLines).toBe(3);
    expect(hunk.isNew).toBe(true);
  });

  it('parses binary file diff', () => {
    const diff = `diff --git a/binary.png b/binary.png
index 1234567..abcdefg 100644
Binary files a/binary.png and b/binary.png differ`;
    const result = parseUnifiedDiff(diff);
    expect(result.files).toContain('binary.png');
    const hunkList = result.hunks.get('binary.png');
    expect(hunkList).toBeDefined();
    expect(hunkList!.length).toBe(1);
    expect(hunkList![0].isBinary).toBe(true);
  });

  it('assigns stable hunk identity', () => {
    const diff = `--- a/foo.ts
+++ b/foo.ts
@@ -1,5 +1,6 @@
 const a = 1;
 const b = 2;
+const newLine = 3;
 const c = 4;
 const d = 5;`;
    const result = parseUnifiedDiff(diff);
    const hunkList = result.hunks.get('foo.ts');
    expect(hunkList).toBeDefined();
    expect(hunkList!.length).toBe(1);
    expect(hunkList![0].identity).toBeDefined();
    expect(typeof hunkList![0].identity).toBe('string');
  });

  it('extracts additions and deletions correctly', () => {
    const diff = `--- a/foo.ts
+++ b/foo.ts
@@ -1,5 +1,5 @@
-const removed = 1;
+const modified = 2;
 const unchanged = 3;`;
    const result = parseUnifiedDiff(diff);
    const hunkList = result.hunks.get('foo.ts');
    expect(hunkList).toBeDefined();
    expect(hunkList!.length).toBe(1);
    expect(hunkList![0].additions).toBe(1);
    expect(hunkList![0].deletions).toBe(1);
  });
});
