import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../git-runner.js';
import { GitWorktreeAdapter } from '../git-worktree-adapter.js';
import { clearTempDirs, getTempDirs, makeTempRepo } from './helpers.js';

let _extraDirs: string[] = [];

afterEach(async () => {
  const dirs = getTempDirs();
  const extra = [..._extraDirs];
  _extraDirs = [];
  clearTempDirs();
  await Promise.all([...dirs, ...extra].map((d) => rm(d, { recursive: true, force: true })));
});

function makeWorktreePath(): string {
  const id = randomBytes(8).toString('hex');
  const p = join(tmpdir(), `ai-sdlc-wt-${id}`);
  _extraDirs.push(p);
  return p;
}

const adapter = new GitWorktreeAdapter();

describe('createWorktree()', () => {
  it('creates a worktree on a new branch off baseBranch', async () => {
    const repoLocalBasePath = await makeTempRepo();
    const worktreePath = makeWorktreePath();

    await adapter.createWorktree({
      repoLocalBasePath,
      worktreePath,
      branch: 'ai/test-branch',
      baseBranch: 'main',
    });

    const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(branch).toBe('ai/test-branch');
  });

  it('is idempotent: a second call is a no-op when the worktree path already exists', async () => {
    const repoLocalBasePath = await makeTempRepo();
    const worktreePath = makeWorktreePath();

    await adapter.createWorktree({
      repoLocalBasePath,
      worktreePath,
      branch: 'ai/idempotent',
      baseBranch: 'main',
    });

    await expect(
      adapter.createWorktree({
        repoLocalBasePath,
        worktreePath,
        branch: 'ai/idempotent',
        baseBranch: 'main',
      }),
    ).resolves.toBeUndefined();

    const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(branch).toBe('ai/idempotent');
  });

  it('attaches an existing branch when the branch already exists in the repo', async () => {
    const repoLocalBasePath = await makeTempRepo();
    const worktreePath = makeWorktreePath();
    await git(repoLocalBasePath, ['branch', 'ai/existing-branch']);

    await adapter.createWorktree({
      repoLocalBasePath,
      worktreePath,
      branch: 'ai/existing-branch',
      baseBranch: 'main',
    });

    const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(branch).toBe('ai/existing-branch');
  });
});
