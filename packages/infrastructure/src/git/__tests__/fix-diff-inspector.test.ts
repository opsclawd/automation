import { rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../git-runner.js';
import { createFixDiffInspector } from '../fix-diff-inspector.js';
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

describe('createFixDiffInspector — file-touched check', () => {
  it('returns touchesPath:false when the fix commit does not touch the flagged path', async () => {
    const repo = await makeTempRepo();
    const startSha = await git(repo, ['rev-parse', 'HEAD']);
    const otherSha = await commitAll(repo, 'unrelated.ts', 'export const x = 1;\n', 'unrelated');
    const inspector = createFixDiffInspector();
    const result = await inspector({
      cwd: repo,
      originalStartCommitSha: startSha,
      runningStartSha: startSha,
      fixCommitSha: otherSha,
      path: 'flagged.ts',
      line: 1,
    });
    expect(result.touchesPath).toBe(false);
    expect(result.nearLine).toBe('skipped');
    expect(result.reason).toContain('does not touch flagged.ts');
  });

  it('returns touchesPath:true when the fix commit edits the flagged path on the flagged line', async () => {
    const repo = await makeTempRepo();
    const startSha = await git(repo, ['rev-parse', 'HEAD']);
    const nextSha = await commitAll(
      repo,
      'flagged.ts',
      ['line 1', 'line 2 (edited)', 'line 3'].join('\n'),
      'edit flagged',
    );
    const inspector = createFixDiffInspector();
    const result = await inspector({
      cwd: repo,
      originalStartCommitSha: startSha,
      runningStartSha: startSha,
      fixCommitSha: nextSha,
      path: 'flagged.ts',
      line: 2,
    });
    expect(result.touchesPath).toBe(true);
    expect(result.nearLine).toBe(true);
  });
});

describe('createFixDiffInspector — line-proximity window', () => {
  it('returns nearLine:false when the only changed line is outside \xb15 lines', async () => {
    const repo = await makeTempRepo();
    const lines = [];
    for (let i = 1; i <= 50; i++) lines.push(`line ${i}`);
    await commitAll(repo, 'flagged.ts', lines.join('\n'), 'baseline');
    const startSha = await git(repo, ['rev-parse', 'HEAD']);

    // Modify line 40 (index 39)
    lines[39] = 'line 40 (edited)';
    const nextSha = await commitAll(repo, 'flagged.ts', lines.join('\n'), 'edit line 40');

    const inspector = createFixDiffInspector();
    const result = await inspector({
      cwd: repo,
      originalStartCommitSha: startSha,
      runningStartSha: startSha,
      fixCommitSha: nextSha,
      path: 'flagged.ts',
      line: 3,
    });
    expect(result.touchesPath).toBe(true);
    expect(result.nearLine).toBe(false);
    expect(result.reason).toMatch(/within .*line 3/);
  });
});

describe('createFixDiffInspector — shift translation', () => {
  it('returns nearLine:true after translating the comment line through a one-commit added line', async () => {
    const repo = await makeTempRepo();
    const baseLines = ['row 1', 'row 2', 'row 3', 'row 4', 'row 5'];
    await writeFile(join(repo, 'shifts.ts'), baseLines.join('\n'), 'utf-8');
    await git(repo, ['add', 'shifts.ts']);
    await git(repo, ['commit', '-m', 'baseline with 5 rows']);
    const originalStartCommitSha = await git(repo, ['rev-parse', 'HEAD']);

    // "Earlier fix in the same poll" inserts 3 rows at the top of the file.
    const shifted = ['row 0a', 'row 0b', 'row 0c', ...baseLines];
    await writeFile(join(repo, 'shifts.ts'), shifted.join('\n'), 'utf-8');
    await git(repo, ['add', 'shifts.ts']);
    await git(repo, ['commit', '-m', 'earlier fix']);
    const runningStartSha = await git(repo, ['rev-parse', 'HEAD']);

    // The "later fix" changes row 4 of the *original* file (line 4). After the
    // earlier fix's 3 added rows, that row now lives at line 7. A naive
    // comparison against line 4 would fail; the translated comparison succeeds.
    const later = [
      'row 0a',
      'row 0b',
      'row 0c',
      'row 1',
      'row 2',
      'row 3',
      'row 4 (CHANGED)',
      'row 5',
    ];
    const laterSha = await commitAll(repo, 'shifts.ts', later.join('\n'), 'later fix');

    const inspector = createFixDiffInspector();
    const result = await inspector({
      cwd: repo,
      originalStartCommitSha,
      runningStartSha,
      fixCommitSha: laterSha,
      path: 'shifts.ts',
      line: 4,
    });
    expect(result.touchesPath).toBe(true);
    expect(result.nearLine).toBe(true);
  });

  it('returns nearLine:skipped when the accumulated diff is ambiguous', async () => {
    // Two earlier fixes with net zero line delta but modification exists — the inspector
    // reports "skipped" rather than guessing.
    const repo = await makeTempRepo();
    const seed = ['r1', 'r2', 'r3'];
    await writeFile(join(repo, 'amb.ts'), seed.join('\n'), 'utf-8');
    await git(repo, ['add', 'amb.ts']);
    await git(repo, ['commit', '-m', 'seed']);
    const originalStartCommitSha = await git(repo, ['rev-parse', 'HEAD']);

    await writeFile(join(repo, 'amb.ts'), ['r1', 'r2 (CHANGED)', 'r3'].join('\n'), 'utf-8');
    await git(repo, ['add', 'amb.ts']);
    await git(repo, ['commit', '-m', 'edit r2']);
    const runningStartSha = await git(repo, ['rev-parse', 'HEAD']);

    const laterSha = await commitAll(
      repo,
      'amb.ts',
      ['r1', 'r2 (CHANGED)', 'r3 (CHANGED)'].join('\n'),
      'later fix',
    );

    const inspector = createFixDiffInspector();
    const result = await inspector({
      cwd: repo,
      originalStartCommitSha,
      runningStartSha,
      fixCommitSha: laterSha,
      path: 'amb.ts',
      line: 3,
    });
    expect(result.touchesPath).toBe(true);
    expect(result.nearLine).toBe('skipped');
    expect(result.reason).toMatch(/ambiguous|skipped/);
  });
});
