import { describe, it, expect } from 'vitest';
import { formatImplementStepHistoryForPrompt } from '../implement-step-history.js';
import type { ImplementStepHistoryEntry } from '../types.js';

describe('formatImplementStepHistoryForPrompt', () => {
  it('returns an empty string when history is empty', () => {
    expect(formatImplementStepHistoryForPrompt([])).toBe('');
    expect(formatImplementStepHistoryForPrompt([], { maxEntries: 3 })).toBe('');
  });

  it('formats history correctly with all fields', () => {
    const history: ImplementStepHistoryEntry[] = [
      {
        iteration: 1,
        specReview: { verdict: 'pass', invocationId: 'sr-1' },
        qualityReview: { verdict: 'pass', invocationId: 'qr-1' },
        fix: {
          verdict: 'done_with_fixes',
          invocationId: 'fix-1',
          headBeforeFix: 'abc123',
          summary: 'Added return type',
        },
        outcome: 'fixed',
      },
    ];

    const result = formatImplementStepHistoryForPrompt(history);
    expect(result).toContain('## Prior Fix Attempts');
    expect(result).toContain('Iteration 1');
    expect(result).toContain('Spec Review: pass');
    expect(result).toContain('Quality Review: pass');
    expect(result).toContain('Fix Verdict: done_with_fixes');
    expect(result).toContain('Head before fix: abc123');
    expect(result).toContain('Fix Summary: Added return type');
    expect(result).toContain('Outcome: fixed');
    expect(result).toMatch(/current code-review\.md is primary/i);
    expect(result).toMatch(/avoid repeating approaches already rejected/i);
  });

  it('includes reverted entry details', () => {
    const history: ImplementStepHistoryEntry[] = [
      {
        iteration: 2,
        specReview: { verdict: 'fail' },
        qualityReview: { verdict: 'fail' },
        reverted: {
          typecheckErrorCount: 3,
          typecheckOutputPreview: 'TS2322: Type X is not assignable',
          headBeforeFix: 'def456',
        },
        outcome: 'unresolved',
      },
    ];

    const result = formatImplementStepHistoryForPrompt(history);
    expect(result).toContain('Reverted (build-breaking fix): 3 typecheck errors');
    expect(result).toContain('Restored HEAD: def456');
    expect(result).toContain('Errors preview: TS2322: Type X is not assignable');
  });

  it('enforces maxEntries cap returning only the newest entries', () => {
    const history: ImplementStepHistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
      iteration: i + 1,
      specReview: {},
      qualityReview: {},
      outcome: 'unresolved',
    }));

    const result = formatImplementStepHistoryForPrompt(history);
    expect(result).toContain('Iteration 6');
    expect(result).toContain('Iteration 10');
    expect(result).not.toContain('Iteration 5');

    const result2 = formatImplementStepHistoryForPrompt(history, { maxEntries: 2 });
    expect(result2).toContain('Iteration 9');
    expect(result2).toContain('Iteration 10');
    expect(result2).not.toContain('Iteration 8');
  });

  it('enforces maxChars cap and truncates at line boundaries where possible', () => {
    const history: ImplementStepHistoryEntry[] = Array.from({ length: 5 }, (_, i) => ({
      iteration: i + 1,
      specReview: { verdict: 'fail' },
      qualityReview: { verdict: 'fail' },
      outcome: 'unresolved',
    }));

    const result = formatImplementStepHistoryForPrompt(history, { maxChars: 250 });
    expect(result.length).toBeLessThanOrEqual(250);
    expect(result.endsWith('\n')).toBe(true);
  });

  it('handles entries without fix or reverted fields', () => {
    const history: ImplementStepHistoryEntry[] = [
      {
        iteration: 1,
        specReview: { verdict: 'pass' },
        qualityReview: { verdict: 'pass' },
        outcome: 'resolved',
      },
    ];

    const result = formatImplementStepHistoryForPrompt(history);
    expect(result).toContain('Iteration 1');
    expect(result).toContain('Spec Review: pass');
    expect(result).toContain('Quality Review: pass');
    expect(result).toContain('Outcome: resolved');
    expect(result).not.toContain('Fix Verdict:');
  });
});
