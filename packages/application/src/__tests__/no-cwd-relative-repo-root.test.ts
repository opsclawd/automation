import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = join(__dirname, '..', '..', '..', '..');

// process.cwd() during a vitest run depends on how vitest was invoked: the
// root-level `pnpm test` script runs a single workspace-wide vitest process
// with cwd already at the repo root, while `pnpm --filter <pkg> test` runs
// with cwd at that package's directory. A fixed `join(process.cwd(), '../..')`
// (or similar) escape to "find the repo root" silently resolves to a
// different — sometimes nonexistent, sometimes coincidentally valid —
// directory depending on which of those invoked it and from where the
// worktree happens to sit on disk. Use `dirname(fileURLToPath(import.meta.url))`
// instead, which is invariant to invocation style.
const DANGEROUS_PATTERN = /process\.cwd\(\)[\s\S]{0,80}?['"`][^'"`]*\.\.[^'"`]*['"`]/;

function walkTestFiles(dir: string, root: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkTestFiles(full, root));
    } else if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) {
      results.push(relative(root, full));
    }
  }
  return results;
}

describe('no test resolves a repo-root path via process.cwd() + parent traversal', () => {
  it('no test file combines process.cwd() with a ".." path segment', () => {
    const scanDirs = [join(WORKSPACE_ROOT, 'packages'), join(WORKSPACE_ROOT, 'apps')];
    const allFiles = scanDirs.flatMap((d) => walkTestFiles(d, WORKSPACE_ROOT));
    expect(allFiles.length, 'must find at least one test file to scan').toBeGreaterThan(0);
    const offenders = allFiles.filter((f) => {
      if (f.endsWith('no-cwd-relative-repo-root.test.ts')) return false;
      const contents = readFileSync(join(WORKSPACE_ROOT, f), 'utf-8');
      return DANGEROUS_PATTERN.test(contents);
    });
    expect(
      offenders,
      'resolve repo-root-relative paths from `dirname(fileURLToPath(import.meta.url))` instead of process.cwd(), which varies by how vitest was invoked',
    ).toEqual([]);
  });
});
