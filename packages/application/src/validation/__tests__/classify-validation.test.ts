import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyCommandKind, summarizeValidationFailure } from '../classify-validation.js';

const FIXTURES = join(__dirname, '__fixtures__');

describe('classifyCommandKind', () => {
  it.each([
    ['pnpm build', 'build'],
    ['pnpm lint', 'lint'],
    ['pnpm typecheck', 'typecheck'],
    ['pnpm test', 'test'],
    ['pnpm test:bash', 'test'],
    ['tsc -p .', 'typecheck'],
    ['eslint .', 'lint'],
    ['echo hi', 'other'],
  ] as const)('maps %s -> %s', (command, expected) => {
    expect(classifyCommandKind(command)).toBe(expected);
  });

  it('matches typecheck before test/build to avoid substring collisions', () => {
    expect(classifyCommandKind('pnpm typecheck:test')).toBe('typecheck');
  });

  it('matches vitest alias to test', () => {
    expect(classifyCommandKind('npx vitest run')).toBe('test');
  });

  it('matches jest alias to test', () => {
    expect(classifyCommandKind('npx jest')).toBe('test');
  });

  it('returns other for empty string', () => {
    expect(classifyCommandKind('')).toBe('other');
  });
});

describe('summarizeValidationFailure', () => {
  it('summarizes a timeout from duration', () => {
    const s = summarizeValidationFailure({
      outcome: 'timed_out',
      durationMs: 1500,
      stderr: '',
      stdout: '',
    });
    expect(s).toMatch(/timed out after 1500ms/i);
  });

  it('uses the tail of stderr for a failure', () => {
    const s = summarizeValidationFailure({
      outcome: 'failed',
      durationMs: 10,
      stderr: 'line1\nline2\nerror TS2345: bad\n',
      stdout: '',
    });
    expect(s).toContain('error TS2345: bad');
  });

  it('falls back to stdout when stderr is empty', () => {
    const s = summarizeValidationFailure({
      outcome: 'failed',
      durationMs: 10,
      stderr: '',
      stdout: 'FAIL src/x.test.ts',
    });
    expect(s).toContain('FAIL src/x.test.ts');
  });

  it('returns fallback message when both stderr and stdout are empty', () => {
    const s = summarizeValidationFailure({
      outcome: 'failed',
      durationMs: 10,
      stderr: '',
      stdout: '',
    });
    expect(s).toBe('command failed with no captured output');
  });

  it('trims trailing whitespace from tail lines', () => {
    const s = summarizeValidationFailure({
      outcome: 'failed',
      durationMs: 10,
      stderr: '  error TS1  \n  error TS2  \n',
      stdout: '',
    });
    expect(s).not.toMatch(/\s+$/m);
  });

  it('produces stable summary for real pnpm typecheck output', () => {
    const stderr = readFileSync(join(FIXTURES, 'pnpm-typecheck-error.stderr'), 'utf-8');
    const s = summarizeValidationFailure({
      outcome: 'failed',
      durationMs: 3200,
      stderr,
      stdout: '',
    });
    expect(s).toMatchSnapshot();
  });

  it('produces stable summary for real pnpm test output', () => {
    const stdout = readFileSync(join(FIXTURES, 'pnpm-test-failure.stdout'), 'utf-8');
    const s = summarizeValidationFailure({
      outcome: 'failed',
      durationMs: 2431,
      stderr: '',
      stdout,
    });
    expect(s).toMatchSnapshot();
  });

  it('produces stable summary for real pnpm lint output', () => {
    const stderr = readFileSync(join(FIXTURES, 'pnpm-lint-error.stderr'), 'utf-8');
    const s = summarizeValidationFailure({
      outcome: 'failed',
      durationMs: 1800,
      stderr,
      stdout: '',
    });
    expect(s).toMatchSnapshot();
  });
});
