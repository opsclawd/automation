import { describe, it, expect } from 'vitest';
import { formatImplementStepHistoryForPrompt } from '../implement-step-history.js';
import type { ImplementStepHistoryEntry } from '../types.js';

describe('formatImplementStepHistoryForPrompt', () => {
  it('returns empty string for empty history', () => {
    expect(formatImplementStepHistoryForPrompt([])).toBe('');
  });

  it('renders an entry with spec/quality/fix info and the reverted block', () => {
    const history: ImplementStepHistoryEntry[] = [
      {
        iteration: 1,
        specReview: { verdict: 'fail', invocationId: 'sr-1' },
        qualityReview: { verdict: 'pass', invocationId: 'qr-1' },
        fix: {
          verdict: 'done_with_fixes',
          invocationId: 'fix-1',
          headBeforeFix: 'abc123',
          summary: 'added guard',
        },
        reverted: {
          headBeforeFix: 'abc123',
          typecheckOutputPreview: 'error TS1128',
          typecheckErrorCount: 1,
        },
        outcome: 'unresolved',
      },
    ];
    const out = formatImplementStepHistoryForPrompt(history);
    expect(out).toContain('## Prior Fix Attempts');
    expect(out).toContain('Iteration 1');
    expect(out).toContain('Spec Review: fail');
    expect(out).toContain('Quality Review: pass');
    expect(out).toContain('Fix Verdict: done_with_fixes');
    expect(out).toContain('Head before fix: abc123');
    expect(out).toContain('Reverted (build-breaking fix)');
    expect(out).toContain('Restored HEAD: abc123');
    expect(out).toContain('Outcome: unresolved');
  });

  it('enforces maxEntries cap', () => {
    const history: ImplementStepHistoryEntry[] = Array.from({ length: 10 }, (_, i) => ({
      iteration: i + 1,
      specReview: { verdict: 'pass' },
      qualityReview: { verdict: 'pass' },
      outcome: 'resolved',
    }));
    const out = formatImplementStepHistoryForPrompt(history);
    expect(out).toContain('Iteration 6');
    expect(out).toContain('Iteration 10');
    expect(out).not.toContain('Iteration 5');
  });

  it('renders extraction failure metadata when present', () => {
    const history: ImplementStepHistoryEntry[] = [
      {
        iteration: 1,
        specReview: {
          classification: 'unrecoverable_artifact',
          violationCode: 'MISSING_REQUIRED_ARTIFACT',
          detail: 'result.json missing',
        },
        qualityReview: { verdict: 'pass' },
        fix: {
          classification: 'invalid_json',
          violationCode: 'MALFORMED_JSON',
          detail: 'SyntaxError at line 1',
        },
        outcome: 'failed',
      },
    ];
    const out = formatImplementStepHistoryForPrompt(history);
    expect(out).toContain('Spec Review Classification: unrecoverable_artifact');
    expect(out).toContain('Spec Review Violation Code: MISSING_REQUIRED_ARTIFACT');
    expect(out).toContain('Spec Review Detail: result.json missing');
    expect(out).toContain('Fix Classification: invalid_json');
    expect(out).toContain('Fix Violation Code: MALFORMED_JSON');
    expect(out).toContain('Fix Detail: SyntaxError at line 1');
  });
});
