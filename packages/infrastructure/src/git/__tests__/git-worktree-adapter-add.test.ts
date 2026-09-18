import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitWorktreeAdapter } from '../git-worktree-adapter.js';
import { git } from '../git-runner.js';

const temporaryRepositories: string[] = [];

async function makeRepository(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'git-selective-add-'));
  temporaryRepositories.push(repo);
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await writeFile(join(repo, 'declared.ts'), 'baseline\n');
  await writeFile(join(repo, 'unrelated.ts'), 'baseline\n');
  await git(repo, ['add', '--', 'declared.ts', 'unrelated.ts']);
  await git(repo, ['commit', '-m', 'baseline']);
  return repo;
}

afterEach(async () => {
  await Promise.all(temporaryRepositories.splice(0).map((repo) => rm(repo, { recursive: true })));
});

describe('GitWorktreeAdapter.add', () => {
  it('stages only the requested tracked and untracked paths', async () => {
    const repo = await makeRepository();
    await writeFile(join(repo, 'declared.ts'), 'requested change\n');
    await writeFile(join(repo, 'unrelated.ts'), 'unrelated change\n');
    await mkdir(join(repo, 'docs', 'adr'), { recursive: true });
    await writeFile(join(repo, 'docs', 'adr', '0001.md'), 'requested new file\n');
    await writeFile(join(repo, 'scratch.md'), 'unrelated new file\n');

    await new GitWorktreeAdapter().add(repo, ['declared.ts', 'docs/adr/0001.md']);

    const staged = await git(repo, ['diff', '--cached', '--name-only']);
    expect(staged.split('\n').filter(Boolean).sort()).toEqual(['declared.ts', 'docs/adr/0001.md']);
    const status = await git(repo, ['status', '--porcelain', '-uall']);
    expect(status).toContain(' M unrelated.ts');
    expect(status).toContain('?? scratch.md');
  });

  it('stages files whose names begin with pathspec-magic characters like colon (:)', async () => {
    const repo = await makeRepository();
    await writeFile(join(repo, ':memory:.ses'), 'sqlite session litter\n');
    await writeFile(join(repo, 'valid.ts'), 'export const a = 1;\n');

    await new GitWorktreeAdapter().add(repo, [':memory:.ses', 'valid.ts']);

    const staged = await git(repo, ['diff', '--cached', '--name-only']);
    expect(staged.split('\n').filter(Boolean).sort()).toEqual([':memory:.ses', 'valid.ts']);
  });

  it('does not throw when staging a file that is already staged as deleted', async () => {
    const repo = await makeRepository();
    await git(repo, ['rm', 'declared.ts']);
    await expect(new GitWorktreeAdapter().add(repo, ['declared.ts'])).resolves.not.toThrow();

    const staged = await git(repo, ['diff', '--cached', '--name-only']);
    expect(staged.split('\n').filter(Boolean)).toEqual(['declared.ts']);
  });

  it('stages remaining dirty files when one file is an already-staged deletion', async () => {
    const repo = await makeRepository();
    await git(repo, ['rm', 'declared.ts']);
    await writeFile(join(repo, 'unrelated.ts'), 'updated\n');

    await new GitWorktreeAdapter().add(repo, ['declared.ts', 'unrelated.ts']);

    const staged = await git(repo, ['diff', '--cached', '--name-only']);
    expect(staged.split('\n').filter(Boolean).sort()).toEqual(['declared.ts', 'unrelated.ts']);

    const sha = await new GitWorktreeAdapter().commit(repo, 'feat: commit all dirty', [
      'declared.ts',
      'unrelated.ts',
    ]);
    expect(sha).toBeDefined();
    const status = await git(repo, ['status', '--porcelain']);
    expect(status).toBe('');
  });

  it('stages unstaged deletions within the requested file list', async () => {
    const repo = await makeRepository();
    await rm(join(repo, 'declared.ts'));

    const statusBefore = await git(repo, ['status', '--porcelain']);
    expect(statusBefore).toContain(' D declared.ts');

    await new GitWorktreeAdapter().add(repo, ['declared.ts']);

    const statusAfter = await git(repo, ['status', '--porcelain']);
    expect(statusAfter).toContain('D  declared.ts');
  });

  it('throws GitFailedError on non-existent files that are not staged deletions', async () => {
    const repo = await makeRepository();
    await expect(new GitWorktreeAdapter().add(repo, ['nonexistent.ts'])).rejects.toThrow();
  });

  it('is a no-op when files list is empty', async () => {
    const repo = await makeRepository();
    await expect(new GitWorktreeAdapter().add(repo, [])).resolves.not.toThrow();
  });
});
