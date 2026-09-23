import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../git-runner.js';
import { GitWorktreeAdapter } from '../git-worktree-adapter.js';
import { clearTempDirs, getTempDirs, makeTempRepo } from './helpers.js';

afterEach(async () => {
  const dirs = getTempDirs();
  clearTempDirs();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const adapter = new GitWorktreeAdapter();

describe('GitWorktreeAdapter.resolveCommitSha()', () => {
  it('resolves HEAD to a 40-character hexadecimal commit SHA', async () => {
    const repo = await makeTempRepo();
    const resolved = await adapter.resolveCommitSha(repo, 'HEAD');
    expect(resolved).toBeDefined();
    expect(resolved).toMatch(/^[0-9a-f]{40}$/i);

    const actualHead = await git(repo, ['rev-parse', 'HEAD']);
    expect(resolved).toBe(actualHead);
  });

  it('peels an annotated tag pointing to a commit to its underlying commit SHA', async () => {
    const repo = await makeTempRepo();
    const headCommit = await git(repo, ['rev-parse', 'HEAD']);
    await git(repo, ['tag', '-a', '-m', 'release 1.0', 'v1.0', 'HEAD']);

    const resolved = await adapter.resolveCommitSha(repo, 'v1.0');
    expect(resolved).toBe(headCommit);
  });

  it('rejects an annotated tag pointing to a tree object and returns undefined', async () => {
    const repo = await makeTempRepo();
    const treeSha = await git(repo, ['rev-parse', 'HEAD^{tree}']);
    await git(repo, ['tag', '-a', '-m', 'tree tag', 'tree-tag', treeSha]);

    const resolved = await adapter.resolveCommitSha(repo, 'tree-tag');
    expect(resolved).toBeUndefined();
  });

  it('rejects a tree object ref (HEAD^{tree}) and returns undefined', async () => {
    const repo = await makeTempRepo();
    const resolved = await adapter.resolveCommitSha(repo, 'HEAD^{tree}');
    expect(resolved).toBeUndefined();
  });

  it('rejects a blob object ref and returns undefined', async () => {
    const repo = await makeTempRepo();
    const resolved = await adapter.resolveCommitSha(repo, 'HEAD:README.md');
    expect(resolved).toBeUndefined();
  });

  it('expands an abbreviated commit SHA to the full 40-character commit SHA', async () => {
    const repo = await makeTempRepo();
    const fullSha = await git(repo, ['rev-parse', 'HEAD']);
    const shortSha = fullSha.slice(0, 7);

    const resolved = await adapter.resolveCommitSha(repo, shortSha);
    expect(resolved).toBe(fullSha);
  });

  it('returns undefined for non-existent or invalid refs', async () => {
    const repo = await makeTempRepo();
    expect(await adapter.resolveCommitSha(repo, 'non-existent-branch')).toBeUndefined();
    expect(await adapter.resolveCommitSha(repo, 'invalid..ref')).toBeUndefined();
    expect(
      await adapter.resolveCommitSha(repo, 'f3e79a24c18b76df429810a019485bb396e69001'),
    ).toBeUndefined();
  });
});

describe('GitWorktreeAdapter.listWorktreeFiles()', () => {
  it('lists tracked, untracked, and ignored files when includeIgnored is true', async () => {
    const repo = await makeTempRepo();
    // README.md is already tracked
    await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
    await git(repo, ['add', '.gitignore']);
    await git(repo, ['commit', '-m', 'add gitignore']);

    await writeFile(join(repo, 'untracked.ts'), 'export const x = 1;\n');
    await writeFile(join(repo, 'ignored.txt'), 'secret\n');

    const filesWithoutIgnored = await adapter.listWorktreeFiles(repo);
    expect(filesWithoutIgnored).toContain('README.md');
    expect(filesWithoutIgnored).toContain('.gitignore');
    expect(filesWithoutIgnored).toContain('untracked.ts');
    expect(filesWithoutIgnored).not.toContain('ignored.txt');

    const filesWithIgnored = await adapter.listWorktreeFiles(repo, { includeIgnored: true });
    expect(filesWithIgnored).toContain('README.md');
    expect(filesWithIgnored).toContain('.gitignore');
    expect(filesWithIgnored).toContain('untracked.ts');
    expect(filesWithIgnored).toContain('ignored.txt');
  });
});

describe('GitWorktreeAdapter.listFilesAtCommit()', () => {
  it('lists exact committed tree files at commit and rejects non-commit SHA', async () => {
    const repo = await makeTempRepo();
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src/index.ts'), 'console.log("hello");\n');
    await git(repo, ['add', 'src/index.ts']);
    await git(repo, ['commit', '-m', 'add index']);

    const headSha = await git(repo, ['rev-parse', 'HEAD']);
    const committedFiles = await adapter.listFilesAtCommit(repo, headSha);

    expect(committedFiles).toEqual(['README.md', 'src/index.ts']);

    await expect(adapter.listFilesAtCommit(repo, 'non-existent-sha')).rejects.toThrow(
      'does not resolve to a commit object',
    );
  });
});
