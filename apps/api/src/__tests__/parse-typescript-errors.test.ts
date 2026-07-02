import { describe, expect, it } from 'vitest';
import { parseTypescriptErrors } from '../compose.js';

describe('parseTypescriptErrors', () => {
  it('parses a single TS error line with file, line, col, code, and message', () => {
    const output =
      "src/domain/run.ts(45,10): error TS2339: Property 'repoId' does not exist on type 'Run'";
    const result = parseTypescriptErrors(output);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      file: 'src/domain/run.ts',
      line: 45,
      col: 10,
      code: 'TS2339',
      message: "Property 'repoId' does not exist on type 'Run'",
    });
  });

  it('parses multiple TS error lines from the same output', () => {
    const output = [
      "src/domain/run.ts(45,10): error TS2339: Property 'repoId' does not exist",
      "src/application/start-run.ts(12,3): error TS2345: Argument of type 'string' is not assignable",
    ].join('\n');
    const result = parseTypescriptErrors(output);
    expect(result).toHaveLength(2);
    expect(result[0]!.file).toBe('src/domain/run.ts');
    expect(result[1]!.file).toBe('src/application/start-run.ts');
  });

  it('returns empty array when output has no parseable TS error lines', () => {
    const output = 'Build failed\npnpm build exited with code 1';
    expect(parseTypescriptErrors(output)).toEqual([]);
  });

  it('ignores non-error lines mixed into the output', () => {
    const output = [
      '> tsc --noEmit',
      "src/foo.ts(5,2): error TS1005: ';' expected",
      'Found 1 error.',
    ].join('\n');
    const result = parseTypescriptErrors(output);
    expect(result).toHaveLength(1);
    expect(result[0]!.code).toBe('TS1005');
  });

  it('handles Windows-style paths in error output', () => {
    const output = "packages\\shared\\src\\index.ts(3,1): error TS2304: Cannot find name 'foo'";
    const result = parseTypescriptErrors(output);
    expect(result).toHaveLength(1);
    expect(result[0]!.line).toBe(3);
    expect(result[0]!.col).toBe(1);
    expect(result[0]!.code).toBe('TS2304');
  });
});
