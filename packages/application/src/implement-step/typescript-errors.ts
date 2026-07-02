import type { TypescriptError } from './types.js';

export type { TypescriptError };

export function parseTypescriptErrors(output: string): TypescriptError[] {
  const pattern = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
  const results: TypescriptError[] = [];
  for (const line of output.split('\n')) {
    const m = pattern.exec(line.trim());
    if (m) {
      results.push({
        file: m[1]!,
        line: parseInt(m[2]!, 10),
        col: parseInt(m[3]!, 10),
        code: m[4]!,
        message: m[5]!,
      });
    }
  }
  return results;
}

export function renderStructuredTypecheckErrors(errors: TypescriptError[]): string[] {
  const byFile = new Map<string, TypescriptError[]>();
  for (const e of errors) {
    const list = byFile.get(e.file) ?? [];
    list.push(e);
    byFile.set(e.file, list);
  }

  const lines: string[] = [
    `## Typecheck Errors From Previous Attempt (${errors.length} error${errors.length === 1 ? '' : 's'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'})`,
    '',
    'Fix ALL of the following errors before committing — do not skip any:',
    '',
  ];

  for (const [file, fileErrors] of byFile) {
    lines.push(`### ${file} (${fileErrors.length} error${fileErrors.length === 1 ? '' : 's'})`);
    for (const e of fileErrors) {
      lines.push(`- Line ${e.line}: ${e.code}: ${e.message}`);
    }
    lines.push('');
  }

  return lines;
}
