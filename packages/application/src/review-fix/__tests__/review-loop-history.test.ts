import { describe, it, expect } from 'vitest';
import { formatReviewLoopHistoryForPrompt } from '../review-loop-history.js';
import type { ReviewLoopHistoryEntry } from '../types.js';

describe('formatReviewLoopHistoryForPrompt', () => {
  it('returns an empty string when history is empty', () => {
    expect(formatReviewLoopHistoryForPrompt([], 'reviewer')).toBe('');
    expect(formatReviewLoopHistoryForPrompt([], 'fixer')).toBe('');
  });

  it('formats history for reviewer correctly', () => {
    const history: ReviewLoopHistoryEntry[] = [
      {
        iteration: 1,
        review: {
          verdict: 'fail',
          invocationId: 'rev-1',
          offendingFindings: [
            { severity: 'high', summary: 'Missing return type' },
            { severity: 'medium', summary: 'Unused variable' },
          ],
          excerpt: 'Please add explicit return type to compile()',
        },
        revalidation: {
          passed: false,
          validationRunId: 'val-1',
          category: 'build',
        },
        outcome: 'unresolved',
      },
    ];

    const result = formatReviewLoopHistoryForPrompt(history, 'reviewer');
    expect(result).toContain('## Prior Iteration History');
    expect(result).toContain('Iteration 1');
    expect(result).toContain('Verdict: fail');
    expect(result).toContain('Missing return type');
    expect(result).toContain('Unused variable');
    expect(result).toContain('Revalidation: failed');
    expect(result).toContain('Category: build');
    expect(result).toContain('Please add explicit return type to compile()');
    // Reviewer instruction check:
    expect(result).toMatch(/history is context, not authority/i);
    expect(result).toMatch(/inspect the current diff/i);
  });

  it('formats history for fixer correctly', () => {
    const history: ReviewLoopHistoryEntry[] = [
      {
        iteration: 1,
        review: {
          verdict: 'fail',
          invocationId: 'rev-1',
          offendingFindings: [{ severity: 'high', summary: 'Missing return type' }],
        },
        fix: {
          verdict: 'done_with_fixes',
          invocationId: 'fix-1',
          headBeforeFix: 'abcdef123',
          summary: 'Added return type to compile() function',
        },
        revalidation: {
          passed: true,
          validationRunId: 'val-1',
        },
        outcome: 'fixed',
      },
    ];

    const result = formatReviewLoopHistoryForPrompt(history, 'fixer');
    expect(result).toContain('## Prior Fix Attempts');
    expect(result).toContain('Iteration 1');
    expect(result).toContain('Verdict: done_with_fixes');
    expect(result).toContain('Head before fix: abcdef123');
    expect(result).toContain('Added return type to compile() function');
    // Fixer instruction check:
    expect(result).toContain('code-review.md');
    expect(result).toMatch(/primary/i);
    expect(result).toMatch(/avoid repeating approaches already rejected/i);
  });

  it('enforces maxEntries cap returning only the newest entries', () => {
    const history: ReviewLoopHistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
      iteration: i + 1,
      review: {
        verdict: 'fail',
        offendingFindings: [{ severity: 'low', summary: `finding ${i + 1}` }],
      },
      outcome: 'unresolved',
    }));

    // maxEntries default is 5. So iteration 6 to 10 should be included, 1 to 5 excluded.
    const result = formatReviewLoopHistoryForPrompt(history, 'reviewer');
    expect(result).toContain('Iteration 6');
    expect(result).toContain('Iteration 10');
    expect(result).not.toContain('Iteration 5');

    // Explicit maxEntries cap of 2:
    const result2 = formatReviewLoopHistoryForPrompt(history, 'reviewer', { maxEntries: 2 });
    expect(result2).toContain('Iteration 9');
    expect(result2).toContain('Iteration 10');
    expect(result2).not.toContain('Iteration 8');
  });

  it('enforces maxChars cap and truncates at line boundaries where possible', () => {
    const history: ReviewLoopHistoryEntry[] = Array.from({ length: 5 }, (_, i) => ({
      iteration: i + 1,
      review: {
        verdict: 'fail',
        offendingFindings: [{ severity: 'low', summary: `finding ${i + 1}` }],
        excerpt: 'line 1\nline 2\nline 3\nline 4\nline 5',
      },
      outcome: 'unresolved',
    }));

    // Check with low maxChars, e.g. 200.
    const result = formatReviewLoopHistoryForPrompt(history, 'reviewer', { maxChars: 250 });
    expect(result.length).toBeLessThanOrEqual(250);
    // Should end with newline
    expect(result.endsWith('\n')).toBe(true);
  });
});
