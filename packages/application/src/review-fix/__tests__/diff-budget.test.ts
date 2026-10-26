import { describe, it, expect } from 'vitest';
import { capDiffForPrompt, DEFAULT_DIFF_CHAR_BUDGET } from '../diff-budget.js';

describe('capDiffForPrompt', () => {
  it('returns the diff unchanged when it fits within the budget', () => {
    const diff = 'diff --git a/file.ts b/file.ts\n+added line\n';
    const result = capDiffForPrompt(diff, 1000);

    expect(result).toEqual({
      text: diff,
      truncated: false,
      originalChars: diff.length,
    });
  });

  it('returns the diff unchanged when it is exactly at the budget', () => {
    const diff = 'a'.repeat(1000);
    const result = capDiffForPrompt(diff, 1000);

    expect(result.truncated).toBe(false);
    expect(result.text).toBe(diff);
  });

  it('truncates a diff that exceeds the budget, keeping the total output within budget', () => {
    const diff = 'HEAD'.padEnd(2000, 'x') + 'TAIL';
    const result = capDiffForPrompt(diff, 1000);

    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(diff.length);
    expect(result.text.length).toBeLessThanOrEqual(1000);
    expect(result.text.startsWith('HEAD')).toBe(true);
    expect(result.text.endsWith('TAIL')).toBe(true);
    expect(result.text).toContain('diff truncated');
  });

  it('never produces output larger than a realistic small budget', () => {
    const diff = 'x'.repeat(10_000);
    const result = capDiffForPrompt(diff, 1000);

    expect(result.text.length).toBeLessThanOrEqual(1000);
  });

  it('deterministically caps a 34MB-scale diff (issue #426 regression) well under the observed 1,048,576-character agent input limit', () => {
    const diff = 'x'.repeat(34_253_226);
    const result = capDiffForPrompt(diff);

    expect(result.truncated).toBe(true);
    expect(result.originalChars).toBe(34_253_226);
    expect(result.text.length).toBeLessThanOrEqual(DEFAULT_DIFF_CHAR_BUDGET);
    expect(result.text.length).toBeLessThan(1_048_576);
  });
});
