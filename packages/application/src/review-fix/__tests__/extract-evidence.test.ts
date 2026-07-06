import { describe, it, expect } from 'vitest';
import { extractEvidence } from '../extract-evidence.js';

describe('extractEvidence', () => {
  it('returns [] for empty input', () => {
    expect(extractEvidence('')).toEqual([]);
  });

  it('returns [] for non-string or garbage input', () => {
    // @ts-expect-error — exercising runtime defensive check
    expect(extractEvidence(null)).toEqual([]);
    // @ts-expect-error — exercising runtime defensive check
    expect(extractEvidence(undefined)).toEqual([]);
  });

  it('extracts inline `path:line` references as path + line entries', () => {
    const md = [
      'The following file has a problem:',
      '',
      'See `src/foo.ts:42` for the bug.',
      '',
      'Also `packages/bar/baz.ts:10` is affected.',
    ].join('\n');
    const evidence = extractEvidence(md);
    expect(evidence).toContainEqual({ path: 'src/foo.ts', line: 42 });
    expect(evidence).toContainEqual({ path: 'packages/bar/baz.ts', line: 10 });
  });

  it('extracts fenced code blocks with path inferred from preceding bold line', () => {
    const md = [
      '**src/foo.ts**',
      '',
      '```ts',
      'const x = 1;',
      'const y = 2;',
      '```',
      '',
      '**packages/bar/baz.ts**',
      '',
      '```ts',
      'export const z = 3;',
      '```',
    ].join('\n');
    const evidence = extractEvidence(md);
    expect(evidence).toContainEqual({
      path: 'src/foo.ts',
      snippet: 'const x = 1;\nconst y = 2;',
    });
    expect(evidence).toContainEqual({
      path: 'packages/bar/baz.ts',
      snippet: 'export const z = 3;',
    });
  });

  it('extracts fenced code blocks with empty path when no preceding bold path', () => {
    const md = ['Some prose', '', '```', 'orphan snippet', '```'].join('\n');
    const evidence = extractEvidence(md);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.snippet).toBe('orphan snippet');
    expect(evidence[0]?.path).toBe('');
  });

  it('extracts a mix of inline refs and fenced code blocks', () => {
    const md = [
      '**src/foo.ts**',
      '',
      'The bug is on `src/foo.ts:5`:',
      '',
      '```ts',
      'const a = 1;',
      '```',
    ].join('\n');
    const evidence = extractEvidence(md);
    expect(evidence.length).toBeGreaterThanOrEqual(2);
    expect(evidence.some((e) => e.path === 'src/foo.ts' && e.line === 5)).toBe(true);
    expect(evidence.some((e) => e.snippet === 'const a = 1;')).toBe(true);
  });

  it('skips inline refs with non-numeric line numbers', () => {
    const md = 'See `src/foo.ts:abc` for details.';
    const evidence = extractEvidence(md);
    expect(evidence).toEqual([]);
  });
});
