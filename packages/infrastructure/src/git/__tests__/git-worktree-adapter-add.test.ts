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
});
