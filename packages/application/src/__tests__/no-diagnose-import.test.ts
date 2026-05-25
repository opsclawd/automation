import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = join(__dirname, '..', '..', '..', '..');

const SOURCE_EXTS = ['.ts', '.tsx', '.mjs'];

function walkSourceFiles(dir: string, root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkSourceFiles(full, root));
    } else if (SOURCE_EXTS.some((ext) => entry.endsWith(ext))) {
      results.push(relative(root, full));
    }
  }
  return results;
}

describe('diagnose-result.ts is not imported by production code', () => {
  it('no production module imports diagnose-result', () => {
    const scanDirs = [join(WORKSPACE_ROOT, 'packages'), join(WORKSPACE_ROOT, 'apps')];
    const allFiles = scanDirs.flatMap((d) => walkSourceFiles(d, WORKSPACE_ROOT));
    expect(allFiles.length, 'must find at least one source file to scan').toBeGreaterThan(0);
    const forbidden = allFiles.filter((f) => {
      if (f.includes('no-diagnose-import.test')) return false;
      if (f.endsWith('diagnose-result.ts')) return false;
      const contents = readFileSync(join(WORKSPACE_ROOT, f), 'utf-8');
      return contents.includes('diagnose-result');
    });
    expect(forbidden).toEqual([]);
  });
});
