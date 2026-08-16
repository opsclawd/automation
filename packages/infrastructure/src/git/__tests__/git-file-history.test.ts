import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitWorktreeAdapter } from '../git-worktree-adapter.js';
import { git } from '../git-runner.js';
import { getTempDirs, clearTempDirs, makeTempRepo } from './helpers.js';

afterEach(async () => {
  const dirs = getTempDirs();
  clearTempDirs();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('GitWorktreeAdapter git history capabilities', () => {
  const adapter = new GitWorktreeAdapter();

  it('createdFiles returns only paths added between base and head', async () => {
    const repo = await makeTempRepo();
    // Base commit has README.md, existing.ts, and deleted.ts
    await writeFile(join(repo, 'existing.ts'), 'export const existing = 1;\n');
    await writeFile(join(repo, 'deleted.ts'), 'export const toDelete = true;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'base commit']);
    const baseSha = await git(repo, ['rev-parse', 'HEAD']);

    // Head commit: modifies existing.ts, deletes deleted.ts, adds new/file.ts and added.ts
    await writeFile(join(repo, 'existing.ts'), 'export const existing = 2;\n');
    await git(repo, ['rm', 'deleted.ts']);
    await mkdir(join(repo, 'new'), { recursive: true });
    await writeFile(join(repo, 'new', 'file.ts'), 'export const newFile = true;\n');
    await writeFile(join(repo, 'added.ts'), 'export const added = true;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'head commit']);
    const headSha = await git(repo, ['rev-parse', 'HEAD']);

    const created = await adapter.createdFiles(repo, baseSha, headSha);
    expect(created).toEqual(['added.ts', 'new/file.ts']);
  });

  it('fileContent preserves exact historical text including trailing newline', async () => {
    const repo = await makeTempRepo();

    // Head commit: adds file with trailing newline
    await mkdir(join(repo, 'new'), { recursive: true });
    const contentWithNewline = 'line1\nline2\n';
    await writeFile(join(repo, 'new', 'file.ts'), contentWithNewline);
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'add file with trailing newline']);
    const headSha = await git(repo, ['rev-parse', 'HEAD']);

    // Later head commit: modifies file to have NO trailing newline
    const contentWithoutNewline = 'line1\nline2';
    await writeFile(join(repo, 'new', 'file.ts'), contentWithoutNewline);
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'modify file without trailing newline']);
    const laterHeadSha = await git(repo, ['rev-parse', 'HEAD']);

    const headContent = await adapter.fileContent(repo, headSha, 'new/file.ts');
    expect(headContent).toBe(contentWithNewline);
    expect(headContent.endsWith('\n')).toBe(true);

    const laterHeadContent = await adapter.fileContent(repo, laterHeadSha, 'new/file.ts');
    expect(laterHeadContent).toBe(contentWithoutNewline);
    expect(laterHeadContent.endsWith('\n')).toBe(false);

    expect(headContent).not.toBe(laterHeadContent);
  });
});
