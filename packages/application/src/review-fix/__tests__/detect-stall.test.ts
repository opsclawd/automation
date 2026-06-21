import { describe, it, expect } from 'vitest';
import { detectStall } from '../detect-stall.js';

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

  it('returns oscillation when one finding oscillates among others', () => {
    expect(
      detectStall(sets(['type error', 'lint nit'], ['lint nit'], ['type error', 'lint nit'])),
    ).toBe('oscillation');
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

  it('applies normalization: matching is case-insensitive and trim-insensitive', () => {
    const h = [new Set(['type error']), new Set(['other']), new Set(['type error'])];
    expect(detectStall(h)).toBe('oscillation');
  });
});
