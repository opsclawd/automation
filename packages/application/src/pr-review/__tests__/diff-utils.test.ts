import { describe, it, expect } from 'vitest';
import { isDiffNearLine } from '../diff-utils.js';

describe('isDiffNearLine', () => {
  it('returns false for empty diff', () => {
    expect(isDiffNearLine('', 10)).toBe(false);
    expect(isDiffNearLine('  ', 10)).toBe(false);
  });

  it('returns true if targetLine is 0 and diff is non-empty', () => {
    const diff = `@@ -1,1 +1,1 @@\n-old\n+new`;
    expect(isDiffNearLine(diff, 0)).toBe(true);
  });

  it('returns true when targetLine is within hunk range', () => {
    const diff = `@@ -10,5 +10,6 @@`;
    expect(isDiffNearLine(diff, 12)).toBe(true);
  });

  it('returns true when targetLine is within window of hunk start', () => {
    const diff = `@@ -20,5 +20,5 @@`;
    // range [20, 24], window 10 -> [10, 34]
    expect(isDiffNearLine(diff, 15)).toBe(true);
    expect(isDiffNearLine(diff, 10)).toBe(true);
  });

  it('returns true when targetLine is within window of hunk end', () => {
    const diff = `@@ -20,5 +20,5 @@`;
    // range [20, 24], window 10 -> [10, 34]
    expect(isDiffNearLine(diff, 30)).toBe(true);
    expect(isDiffNearLine(diff, 34)).toBe(true);
  });

  it('returns false when targetLine is outside hunk and window', () => {
    const diff = `@@ -20,5 +20,5 @@`;
    // range [20, 24], window 10 -> [10, 34]
    expect(isDiffNearLine(diff, 9)).toBe(false);
    expect(isDiffNearLine(diff, 35)).toBe(false);
  });

  it('handles multiple hunks', () => {
    const diff = `
@@ -10,1 +10,1 @@
-a
+b
@@ -50,1 +50,1 @@
-c
+d
    `;
    expect(isDiffNearLine(diff, 12)).toBe(true);
    expect(isDiffNearLine(diff, 30)).toBe(false);
    expect(isDiffNearLine(diff, 52)).toBe(true);
  });

  it('handles hunks with single line count (implicit ,1)', () => {
    const diff = `@@ -10 +10 @@`;
    expect(isDiffNearLine(diff, 10)).toBe(true);
    expect(isDiffNearLine(diff, 20)).toBe(true);
    expect(isDiffNearLine(diff, 21)).toBe(false);
  });
});
