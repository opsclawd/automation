import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TrackedSourceDriftError } from '@ai-sdlc/application/ports';
import { git } from '../git-runner.js';
import { GitWorktreeAdapter } from '../git-worktree-adapter.js';
import { clearTempDirs, getTempDirs, makeTempRepo, makeRepoWithRemote } from './helpers.js';

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

describe('remoteRef()', () => {
  it('returns the SHA of an existing ref', async () => {
    const { repo, branchSha } = await makeRepoWithRemote();
    const sha = await adapter.remoteRef({ cwd: repo, remote: 'origin', ref: 'main' });
    expect(sha).toBe(branchSha);
  });

  it('returns undefined for a non-existent ref', async () => {
    const { repo } = await makeRepoWithRemote();
    const sha = await adapter.remoteRef({ cwd: repo, remote: 'origin', ref: 'nonexistent' });
    expect(sha).toBeUndefined();
  });

  it('returns undefined for a non-existent remote', async () => {
    const repo = await makeTempRepo();
    const sha = await adapter.remoteRef({ cwd: repo, remote: 'origin', ref: 'main' });
    expect(sha).toBeUndefined();
  });

  it('prefers refs/heads/ when an unqualified ref matches both branch and tag', async () => {
    const { repo } = await makeRepoWithRemote();
    const branchSha = await git(repo, ['rev-parse', 'HEAD']);

    // Create a tag called 'main' pointing to a different (parent) commit
    await writeFile(join(repo, 'second.txt'), 'second\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'second commit']);
    await git(repo, ['push', 'origin', 'main']);
    const newBranchSha = await git(repo, ['rev-parse', 'HEAD']);

    // Tag 'main' pointing to the original SHA
    await git(repo, ['tag', 'main', branchSha]);
    await git(repo, ['push', 'origin', 'refs/tags/main']);

    const sha = await adapter.remoteRef({ cwd: repo, remote: 'origin', ref: 'main' });
    expect(sha).toBe(newBranchSha);
  });

  it('matches exact refs/heads/ line when ref is fully qualified', async () => {
    const { repo, branchSha } = await makeRepoWithRemote();
    const sha = await adapter.remoteRef({
      cwd: repo,
      remote: 'origin',
      ref: 'refs/heads/main',
    });
    expect(sha).toBe(branchSha);
  });

  it('resolves a fully qualified refs/tags/ ref', async () => {
    const { repo } = await makeRepoWithRemote();
    const branchSha = await git(repo, ['rev-parse', 'HEAD']);
    await git(repo, ['tag', 'v1', branchSha]);
    await git(repo, ['push', 'origin', 'refs/tags/v1']);

    const sha = await adapter.remoteRef({
      cwd: repo,
      remote: 'origin',
      ref: 'refs/tags/v1',
    });
    expect(sha).toBe(branchSha);
  });
});

describe('reproduces parity #318 (branch-switch hard-fail / dirty warn)', () => {
  it('throws TrackedSourceDriftError when a tracked file has been modified', async () => {
    const repo = await makeTempRepo();

    // README.md is a tracked file; modifying it constitutes tracked-source drift
    await writeFile(join(repo, 'README.md'), 'drifted content\n');

    await expect(adapter.resetWorktreeIfClean(repo, 'HEAD')).rejects.toThrow(
      TrackedSourceDriftError,
    );
  });
});

describe('reproduces parity #348 (exclude pre-existing dirty from violations)', () => {
  it('does not throw for untracked files (reviewer artifacts)', async () => {
    const repo = await makeTempRepo();

    // new-artifact.txt is untracked — must be tolerated
    await writeFile(join(repo, 'new-artifact.txt'), 'reviewer artifact\n');

    await expect(adapter.resetWorktreeIfClean(repo, 'HEAD')).resolves.toBeUndefined();
  });
});

describe('reproduces parity #351 (untracked detection + clean gate)', () => {
  it('resets worktree HEAD to baseBranch when clean of tracked changes', async () => {
    const repo = await makeTempRepo();
    const baseSha = await git(repo, ['rev-parse', 'HEAD']);

    // Advance the repo past the base commit
    await writeFile(join(repo, 'extra.txt'), 'extra\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'extra commit']);

    await adapter.resetWorktreeIfClean(repo, baseSha);

    const headAfter = await git(repo, ['rev-parse', 'HEAD']);
    expect(headAfter).toBe(baseSha);
  });

  it('resolves without error when worktree is fully clean', async () => {
    const repo = await makeTempRepo();

    await expect(adapter.resetWorktreeIfClean(repo, 'HEAD')).resolves.toBeUndefined();
  });
});
