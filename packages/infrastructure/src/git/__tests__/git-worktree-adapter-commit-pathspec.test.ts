import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../git-runner.js';
import { GitWorktreeAdapter } from '../git-worktree-adapter.js';
import { clearTempDirs, getTempDirs, makeTempRepo } from './helpers.js';

type CommitWithOptionalPathspec = (
  cwd: string,
  message: string,
  files?: readonly string[],
) => Promise<string>;

afterEach(async () => {
  const dirs = getTempDirs();
  clearTempDirs();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stageCommitCandidates(repo: string): Promise<void> {
  await writeFile(join(repo, 'declared.txt'), 'declared\n');
  await writeFile(join(repo, 'orchestrator-artifact.json'), '{"artifact":true}\n');
  await git(repo, ['add', '--', 'declared.txt', 'orchestrator-artifact.json']);
}

async function commit(
  adapter: GitWorktreeAdapter,
  cwd: string,
  files?: readonly string[],
): Promise<string> {
  const commitWithPathspec = adapter.commit.bind(adapter) as CommitWithOptionalPathspec;
  return commitWithPathspec(cwd, 'fix: recover declared work', files);
}

async function commitPaths(repo: string, sha: string): Promise<string[]> {
  const output = await git(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]);
  return output.split('\n').filter(Boolean).sort();
}

describe('GitWorktreeAdapter.commit() pathspec', () => {
  it('commits only requested paths and leaves unrelated staged content in the index', async () => {
    const repo = await makeTempRepo();
    const adapter = new GitWorktreeAdapter();
    await stageCommitCandidates(repo);

    const sha = await commit(adapter, repo, ['declared.txt']);

    expect(await commitPaths(repo, sha)).toEqual(['declared.txt']);
    expect(await git(repo, ['diff', '--cached', '--name-only'])).toBe('orchestrator-artifact.json');
    expect((await git(repo, ['ls-tree', '-r', '--name-only', sha])).split('\n')).not.toContain(
      'orchestrator-artifact.json',
    );
  });

  it('keeps whole-index commit behavior when pathspec is omitted', async () => {
    const repo = await makeTempRepo();
    const adapter = new GitWorktreeAdapter();
    await stageCommitCandidates(repo);

    const sha = await commit(adapter, repo);

    expect(await commitPaths(repo, sha)).toEqual(['declared.txt', 'orchestrator-artifact.json']);
    expect(await git(repo, ['status', '--porcelain'])).toBe('');
  });

  it('keeps whole-index commit behavior when pathspec is empty', async () => {
    const repo = await makeTempRepo();
    const adapter = new GitWorktreeAdapter();
    await stageCommitCandidates(repo);

    const sha = await commit(adapter, repo, []);

    expect(await commitPaths(repo, sha)).toEqual(['declared.txt', 'orchestrator-artifact.json']);
    expect(await git(repo, ['status', '--porcelain'])).toBe('');
  });
});
