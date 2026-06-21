import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
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

  it('recovers from a stale empty directory (crash after mkdir, before git worktree add)', async () => {
    const repoLocalBasePath = await makeTempRepo();
    const worktreePath = makeWorktreePath();
    await mkdir(worktreePath, { recursive: true });

    await adapter.createWorktree({
      repoLocalBasePath,
      worktreePath,
      branch: 'ai/stale-recovery',
      baseBranch: 'main',
    });

    const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(branch).toBe('ai/stale-recovery');
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

describe('removeWorktree()', () => {
  it('removes the worktree directory and deregisters it from git', async () => {
    const repoLocalBasePath = await makeTempRepo();
    const worktreePath = makeWorktreePath();
    await adapter.createWorktree({
      repoLocalBasePath,
      worktreePath,
      branch: 'ai/remove-test',
      baseBranch: 'main',
    });

    await adapter.removeWorktree(worktreePath);

    const list = await git(repoLocalBasePath, ['worktree', 'list', '--porcelain']);
    expect(list).not.toContain(worktreePath);
  });
});

describe('reproduces parity #295 (runs never mutate the main checkout)', () => {
  it('main checkout HEAD is unchanged after worktree commit and resetHard', async () => {
    const { writeFile } = await import('node:fs/promises');
    const repoLocalBasePath = await makeTempRepo();
    const worktreePath = makeWorktreePath();
    await adapter.createWorktree({
      repoLocalBasePath,
      worktreePath,
      branch: 'ai/parity-295',
      baseBranch: 'main',
    });

    const mainHeadBefore = await git(repoLocalBasePath, ['rev-parse', 'HEAD']);

    // Commit a new file inside the worktree
    await writeFile(join(worktreePath, 'parity-295.txt'), 'content\n');
    await git(worktreePath, ['add', '.']);
    await adapter.commit(worktreePath, 'feat: worktree-only commit');

    // Reset the worktree back to the base commit
    await adapter.resetHard(worktreePath, mainHeadBefore);

    // Main checkout HEAD must not have moved
    const mainHeadAfter = await git(repoLocalBasePath, ['rev-parse', 'HEAD']);
    expect(mainHeadAfter).toBe(mainHeadBefore);

    // Working directory of main checkout is clean
    const status = await git(repoLocalBasePath, ['status', '--porcelain']);
    expect(status).toBe('');
  });
});

describe('currentBranch()', () => {
  it('returns the active branch name inside the worktree', async () => {
    const repoLocalBasePath = await makeTempRepo();
    const worktreePath = makeWorktreePath();
    await adapter.createWorktree({
      repoLocalBasePath,
      worktreePath,
      branch: 'ai/branch-check',
      baseBranch: 'main',
    });

    const branch = await adapter.currentBranch(worktreePath);
    expect(branch).toBe('ai/branch-check');
  });
});

describe('headCommitSha()', () => {
  it('returns a 40-character hex SHA for the HEAD commit', async () => {
    const repoLocalBasePath = await makeTempRepo();
    const worktreePath = makeWorktreePath();
    await adapter.createWorktree({
      repoLocalBasePath,
      worktreePath,
      branch: 'ai/sha-check',
      baseBranch: 'main',
    });

    const sha = await adapter.headCommitSha(worktreePath);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('headCommitShaOf()', () => {
  it('returns the HEAD SHA of a valid repository', async () => {
    const repoLocalBasePath = await makeTempRepo();

    const sha = await adapter.headCommitShaOf(repoLocalBasePath);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});
