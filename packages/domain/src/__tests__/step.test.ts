import { describe, it, expect } from 'vitest';
import { RunId, PhaseName } from '../ids.js';
import { createStep, normalizeTaskPath } from '../step.js';

describe('createStep', () => {
  it('creates a pending step with no startedAt or completedAt', () => {
    const s = createStep({
      id: 'step-1',
      runId: RunId('run-1'),
      phaseId: PhaseName('validate'),
      index: 0,
      title: 'Typecheck',
    });

    expect(s.id).toBe('step-1');
    expect(s.runId).toBe('run-1');
    expect(s.status).toBe('pending');
    expect(s.startedAt).toBeUndefined();
    expect(s.completedAt).toBeUndefined();
  });

  it('createStep initializes revertCounts to an empty map', () => {
    const s1 = createStep({
      id: 'step-1',
      runId: RunId('run-1'),
      phaseId: PhaseName('implement'),
      index: 0,
      title: 'Step 1',
    });
    const s2 = createStep({
      id: 'step-2',
      runId: RunId('run-1'),
      phaseId: PhaseName('implement'),
      index: 1,
      title: 'Step 2',
    });

    expect(s1.revertCounts).toEqual({});
    expect(s2.revertCounts).toEqual({});
    expect(s1.revertCounts).not.toBe(s2.revertCounts);

    // Mutating one step's revert map does not affect another step
    s1.revertCounts['src/foo.ts'] = 1;
    expect(s2.revertCounts).toEqual({});
  });
});

describe('normalizeTaskPath', () => {
  it('returns empty string for non-string, empty, or whitespace-only inputs', () => {
    expect(normalizeTaskPath(undefined)).toBe('');
    expect(normalizeTaskPath(null)).toBe('');
    expect(normalizeTaskPath(123)).toBe('');
    expect(normalizeTaskPath({})).toBe('');
    expect(normalizeTaskPath('')).toBe('');
    expect(normalizeTaskPath('   ')).toBe('');
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(normalizeTaskPath('src\\foo\\bar.ts')).toBe('src/foo/bar.ts');
    expect(normalizeTaskPath('foo\\\\bar\\\\baz.ts')).toBe('foo/bar/baz.ts');
  });

  it('resolves current directory dot segments and double slashes', () => {
    expect(normalizeTaskPath('./src/./foo//bar.ts')).toBe('src/foo/bar.ts');
    expect(normalizeTaskPath('src/./foo//bar/../baz.ts')).toBe('src/foo/baz.ts');
  });

  it('resolves parent directory dot-dot segments and root traversals', () => {
    expect(normalizeTaskPath('packages/application/src/../../domain/src/index.ts')).toBe(
      'packages/domain/src/index.ts',
    );
    expect(normalizeTaskPath('src/../.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
    expect(normalizeTaskPath('../../.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
  });

  it('handles clean standard relative paths without changes', () => {
    expect(normalizeTaskPath('src/foo/bar.ts')).toBe('src/foo/bar.ts');
    expect(normalizeTaskPath('package.json')).toBe('package.json');
  });
});
