import { rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../git-runner.js';
import { createFindingEvidenceInspector } from '../finding-evidence-inspector.js';
import { clearTempDirs, getTempDirs, makeTempRepo } from './helpers.js';

afterEach(async () => {
  const dirs = getTempDirs();
  clearTempDirs();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function commitAll(
  repoPath: string,
  filename: string,
  contents: string,
  message: string,
): Promise<string> {
  await writeFile(join(repoPath, filename), contents, 'utf-8');
  await git(repoPath, ['add', filename]);
  await git(repoPath, ['commit', '-m', message]);
  return git(repoPath, ['rev-parse', 'HEAD']);
}

describe('createFindingEvidenceInspector', () => {
  it('returns evidenceConfirmed: false when file does not exist', async () => {
    const repo = await makeTempRepo();
    const sha = await git(repo, ['rev-parse', 'HEAD']);
    const inspector = createFindingEvidenceInspector();

    const result = await inspector({
      cwd: repo,
      ref: sha,
      evidence: {
        path: 'nonexistent.ts',
      },
    });

    expect(result.evidenceConfirmed).toBe(false);
    expect(result.reason).toContain("path 'nonexistent.ts' does not exist at ref");
  });

  it('returns evidenceConfirmed: true when file exists and no line/snippet is requested', async () => {
    const repo = await makeTempRepo();
    const sha = await commitAll(repo, 'exists.ts', 'const x = 1;\n', 'add exists.ts');
    const inspector = createFindingEvidenceInspector();

    const result = await inspector({
      cwd: repo,
      ref: sha,
      evidence: {
        path: 'exists.ts',
      },
    });

    expect(result.evidenceConfirmed).toBe(true);
    expect(result.reason).toBe('evidence confirmed');
  });

  it('checks line ranges: returns false if out of range', async () => {
    const repo = await makeTempRepo();
    const sha = await commitAll(repo, 'lines.ts', 'line 1\nline 2\nline 3', 'add lines.ts');
    const inspector = createFindingEvidenceInspector();

    // Check line 0 (out of range, < 1)
    const resLow = await inspector({
      cwd: repo,
      ref: sha,
      evidence: {
        path: 'lines.ts',
        line: 0,
      },
    });
    expect(resLow.evidenceConfirmed).toBe(false);
    expect(resLow.reason).toContain('line 0 is out of range');

    // Check line 4 (out of range, > 3)
    const resHigh = await inspector({
      cwd: repo,
      ref: sha,
      evidence: {
        path: 'lines.ts',
        line: 4,
      },
    });
    expect(resHigh.evidenceConfirmed).toBe(false);
    expect(resHigh.reason).toContain('line 4 is out of range');

    // Check line 2 (in range)
    const resOk = await inspector({
      cwd: repo,
      ref: sha,
      evidence: {
        path: 'lines.ts',
        line: 2,
      },
    });
    expect(resOk.evidenceConfirmed).toBe(true);
  });

  it('checks snippet anywhere in the file when no line is specified', async () => {
    const repo = await makeTempRepo();
    const content = ['class Foo {', '  bar() {', '    return 42;', '  }', '}'].join('\n');
    const sha = await commitAll(repo, 'code.ts', content, 'add code.ts');
    const inspector = createFindingEvidenceInspector();

    // Matching snippet
    const resMatch = await inspector({
      cwd: repo,
      ref: sha,
      evidence: {
        path: 'code.ts',
        snippet: 'return 42;',
      },
    });
    expect(resMatch.evidenceConfirmed).toBe(true);

    // Matching snippet with different whitespace/newlines
    const resWhitespace = await inspector({
      cwd: repo,
      ref: sha,
      evidence: {
        path: 'code.ts',
        snippet: 'bar() { \n return 42; \n }',
      },
    });
    expect(resWhitespace.evidenceConfirmed).toBe(true);

    // Non-matching snippet
    const resMismatch = await inspector({
      cwd: repo,
      ref: sha,
      evidence: {
        path: 'code.ts',
        snippet: 'return 100;',
      },
    });
    expect(resMismatch.evidenceConfirmed).toBe(false);
    expect(resMismatch.reason).toContain('snippet not found within ±5 lines');
  });

  it('checks snippet within ±5 line window around specified line', async () => {
    const repo = await makeTempRepo();
    // 20 lines file
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    // Put snippet at line 15
    lines[14] = 'const TARGET_SNIPPET = 123;';
    const sha = await commitAll(repo, 'proximity.ts', lines.join('\n'), 'add proximity.ts');
    const inspector = createFindingEvidenceInspector();

    // Check at line 15 (exact match, should pass)
    const resExact = await inspector({
      cwd: repo,
      ref: sha,
      evidence: {
        path: 'proximity.ts',
        line: 15,
        snippet: 'const TARGET_SNIPPET = 123;',
      },
    });
    expect(resExact.evidenceConfirmed).toBe(true);

    // Check at line 18 (distance 3, window is 18-6 = 12 to 18+5 = 23, includes 15, should pass)
    const resNear = await inspector({
      cwd: repo,
      ref: sha,
      evidence: {
        path: 'proximity.ts',
        line: 18,
        snippet: 'TARGET_SNIPPET',
      },
    });
    expect(resNear.evidenceConfirmed).toBe(true);

    // Check at line 2 (distance 13, window is 0 to 7, does not include 15, should fail)
    const resFar = await inspector({
      cwd: repo,
      ref: sha,
      evidence: {
        path: 'proximity.ts',
        line: 2,
        snippet: 'TARGET_SNIPPET',
      },
    });
    expect(resFar.evidenceConfirmed).toBe(false);
    expect(resFar.reason).toContain('snippet not found within ±5 lines of 2');
  });
});
