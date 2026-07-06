import { describe, it, expect } from 'vitest';
import { detectConvergingTrend, detectStall } from '../detect-stall.js';

function sets(...entries: string[][]): Array<Set<string>> {
  return entries.map((e) => new Set(e));
}

describe('detectStall', () => {
  it('returns none when history has fewer than 3 entries', () => {
    expect(detectStall([])).toBe('none');
    expect(detectStall(sets(['type error']))).toBe('none');
    expect(detectStall(sets(['type error'], ['type error']))).toBe('none');
  });

  it('returns none when no finding recurs across 3 iterations (all different)', () => {
    expect(detectStall(sets(['a'], ['b'], ['c']))).toBe('none');
  });

  it('returns oscillation when a finding is in N and N-2 but not N-1', () => {
    expect(detectStall(sets(['type error'], ['unused import'], ['type error']))).toBe(
      'oscillation',
    );
  });

  it('returns no_progress over oscillation when both patterns coexist', () => {
    expect(
      detectStall(sets(['type error', 'lint nit'], ['lint nit'], ['type error', 'lint nit'])),
    ).toBe('no_progress');
  });

  it('returns no_progress when a finding persists across all 3 iterations', () => {
    expect(detectStall(sets(['type error'], ['type error'], ['type error']))).toBe('no_progress');
  });

  it('returns no_progress when one of multiple findings persists across all 3', () => {
    expect(detectStall(sets(['type error', 'lint nit'], ['type error'], ['type error']))).toBe(
      'no_progress',
    );
  });

  it('returns none when all 3 iterations have empty finding sets', () => {
    expect(detectStall(sets([], [], []))).toBe('none');
  });

  it('uses only the last 3 entries when history is longer', () => {
    expect(detectStall(sets(['a'], ['b'], ['a'], ['c'], ['c'], ['c']))).toBe('no_progress');
  });

  it('returns oscillation when a finding reappears after being absent', () => {
    const h = [new Set(['type error']), new Set(['other']), new Set(['type error'])];
    expect(detectStall(h)).toBe('oscillation');
  });

  // Normalization (case/trim) is the caller's responsibility, handled in review-fix-loop.ts.
  // See review-fix-loop.ts lines 111-112 for the normalization call site.
});

describe('detectConvergingTrend (#627)', () => {
  const makeEntry = (
    findings: Array<{ severity: string; summary: string }>,
    fixVerdict: 'done_with_fixes' | 'done_no_fixes_needed' = 'done_with_fixes',
    revalPassed = true,
  ) => ({
    review: { offendingFindings: findings },
    fix: { verdict: fixVerdict },
    revalidation: { passed: revalPassed },
    outcome: 'fixed' as const,
  });

  it('returns converging=true in strict mode when severity-weighted counts decrease and last reval passed', () => {
    const history = [
      makeEntry([
        { severity: 'high', summary: 'a' },
        { severity: 'high', summary: 'b' },
      ]),
      makeEntry([{ severity: 'high', summary: 'a' }]),
      makeEntry([{ severity: 'high', summary: 'b' }]),
    ];
    const result = detectConvergingTrend(history, {
      mode: 'strict',
      lastRevalidationPassed: true,
    });
    expect(result.converging).toBe(true);
    expect(result.severityWeighted).toEqual([4, 2, 2]);
  });

  it('returns converging=false in strict mode when last reval did not pass', () => {
    const history = [
      makeEntry([{ severity: 'high', summary: 'a' }]),
      makeEntry([{ severity: 'high', summary: 'b' }]),
      makeEntry([{ severity: 'medium', summary: 'c' }]),
    ];
    const result = detectConvergingTrend(history, {
      mode: 'strict',
      lastRevalidationPassed: false,
    });
    expect(result.converging).toBe(false);
    expect(result.severityWeighted).toEqual([2, 2, 1]);
  });

  it('returns converging=true in lenient mode regardless of last reval', () => {
    const history = [
      makeEntry([{ severity: 'critical', summary: 'a' }]),
      makeEntry([{ severity: 'high', summary: 'b' }]),
      makeEntry([{ severity: 'medium', summary: 'c' }]),
    ];
    const result = detectConvergingTrend(history, {
      mode: 'lenient',
      lastRevalidationPassed: false,
    });
    expect(result.converging).toBe(true);
    expect(result.severityWeighted).toEqual([4, 2, 1]);
  });

  it('returns converging=false when severity-weighted counts are flat (not strictly decreasing)', () => {
    const history = [
      makeEntry([{ severity: 'high', summary: 'a' }]),
      makeEntry([{ severity: 'high', summary: 'a' }]),
    ];
    const result = detectConvergingTrend(history, { mode: 'lenient' });
    expect(result.converging).toBe(false);
  });

  it('returns converging=false when there are fewer than `window` fix iterations', () => {
    const history = [makeEntry([{ severity: 'high', summary: 'a' }])];
    const result = detectConvergingTrend(history, { mode: 'lenient' });
    expect(result.converging).toBe(false);
    expect(result.severityWeighted).toEqual([]);
  });
});
