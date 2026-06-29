import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TrackedSourceDriftError } from '@ai-sdlc/application/ports';
import { git } from '../git-runner.js';
import { GitWorktreeAdapter, orchestratorExcludePatterns } from '../git-worktree-adapter.js';
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

describe('diff()', () => {
  it('returns empty string when working tree is clean', async () => {
    const repo = await makeTempRepo();
    const patch = await adapter.diff(repo, 'HEAD');
    expect(patch).toBe('');
  });

  it('returns patch text for an unstaged working-tree change', async () => {
    const repo = await makeTempRepo();
    await writeFile(join(repo, 'README.md'), 'modified\n');
    const patch = await adapter.diff(repo, 'HEAD');
    expect(patch).toContain('-initial');
    expect(patch).toContain('+modified');
  });

  it('returns diff between two commits when head sha is supplied', async () => {
    const repo = await makeTempRepo();
    const base = await git(repo, ['rev-parse', 'HEAD']);
    await writeFile(join(repo, 'README.md'), 'v2\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'v2']);
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const patch = await adapter.diff(repo, base, head);
    expect(patch).toContain('-initial');
    expect(patch).toContain('+v2');
  });
});

describe('push()', () => {
  it('pushes local HEAD to the bare remote and the remote ref advances', async () => {
    const { repo } = await makeRepoWithRemote();
    await writeFile(join(repo, 'pushed.txt'), 'pushed\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'new commit to push']);
    const expectedSha = await git(repo, ['rev-parse', 'HEAD']);

    await adapter.push({ cwd: repo, branch: 'main', remote: 'origin' });

    const remoteSha = await adapter.remoteRef({ cwd: repo, remote: 'origin', ref: 'main' });
    expect(remoteSha).toBe(expectedSha);
  });

  it('defaults remote to "origin" when remote is omitted', async () => {
    const { repo } = await makeRepoWithRemote();
    await writeFile(join(repo, 'default-remote.txt'), 'x\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'default-remote commit']);
    const expectedSha = await git(repo, ['rev-parse', 'HEAD']);

    await adapter.push({ cwd: repo, branch: 'main' });

    const remoteSha = await adapter.remoteRef({ cwd: repo, remote: 'origin', ref: 'main' });
    expect(remoteSha).toBe(expectedSha);
  });
});

describe('isAncestor()', () => {
  it('returns true when the first commit is a parent of the second', async () => {
    const repo = await makeTempRepo();
    const parent = await git(repo, ['rev-parse', 'HEAD']);
    await writeFile(join(repo, 'child.txt'), 'child\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'child commit']);
    const child = await git(repo, ['rev-parse', 'HEAD']);

    expect(await adapter.isAncestor(repo, parent, child)).toBe(true);
  });

  it('returns false when the arguments are reversed (descendant is not ancestor of parent)', async () => {
    const repo = await makeTempRepo();
    const parent = await git(repo, ['rev-parse', 'HEAD']);
    await writeFile(join(repo, 'child2.txt'), 'child\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'child2 commit']);
    const child = await git(repo, ['rev-parse', 'HEAD']);

    expect(await adapter.isAncestor(repo, child, parent)).toBe(false);
  });

  it('returns true when ancestor === descendant (a commit is its own ancestor)', async () => {
    const repo = await makeTempRepo();
    const sha = await git(repo, ['rev-parse', 'HEAD']);

    expect(await adapter.isAncestor(repo, sha, sha)).toBe(true);
  });
});

describe('logBetween()', () => {
  it('returns an empty array when base and head are the same commit', async () => {
    const repo = await makeTempRepo();
    const sha = await git(repo, ['rev-parse', 'HEAD']);
    expect(await adapter.logBetween(repo, sha, sha)).toEqual([]);
  });

  it('returns subject lines newest-first for commits between base and head', async () => {
    const repo = await makeTempRepo();
    const base = await git(repo, ['rev-parse', 'HEAD']);

    await writeFile(join(repo, 'a.txt'), 'a\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'feat: add a']);

    await writeFile(join(repo, 'b.txt'), 'b\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'feat: add b']);

    const head = await git(repo, ['rev-parse', 'HEAD']);
    const log = await adapter.logBetween(repo, base, head);

    expect(log).toEqual(['feat: add b', 'feat: add a']);
  });
});

describe('cleanUntracked()', () => {
  it('removes gitignored files (requires -x flag)', async () => {
    const repo = await makeTempRepo();
    // Simulate a .gitignore entry — create it first
    await writeFile(join(repo, '.gitignore'), 'ignored-artifact.json\n');
    await git(repo, ['add', '.gitignore']);
    await git(repo, ['commit', '-m', 'add gitignore']);
    // Write a gitignored file
    await writeFile(join(repo, 'ignored-artifact.json'), '{"status":"stale"}\n');
    // Without -x, git clean -fd would leave this file; with -x it must be removed
    await adapter.cleanUntracked(repo);
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(repo);
    expect(files).not.toContain('ignored-artifact.json');
  });

  it('does not remove node_modules (requires -e node_modules)', async () => {
    const repo = await makeTempRepo();
    await mkdir(join(repo, 'node_modules'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'pkg.js'), 'export {};\n');
    // node_modules is typically gitignored; -x without -e would delete it
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
    await git(repo, ['add', '.gitignore']);
    await git(repo, ['commit', '-m', 'add gitignore']);
    await adapter.cleanUntracked(repo);
    const { access: fsAccess } = await import('node:fs/promises');
    await expect(fsAccess(join(repo, 'node_modules', 'pkg.js'))).resolves.toBeUndefined();
  });
});

describe('Artifact Guarding & Cleanup', () => {
  describe('seedArtifactExcludes()', () => {
    it('writes every canonical artifact and *.patch', async () => {
      const repoPath = await makeTempRepo();
      await adapter.seedArtifactExcludes(repoPath);

      const gitCommonDir = await git(repoPath, ['rev-parse', '--git-common-dir']);
      const excludeFile = isAbsolute(gitCommonDir)
        ? join(gitCommonDir, 'info', 'exclude')
        : resolve(repoPath, gitCommonDir, 'info', 'exclude');
      const content = await readFile(excludeFile, 'utf8');

      const expectedPatterns = orchestratorExcludePatterns();
      for (const pattern of expectedPatterns) {
        expect(content).toContain(pattern);
      }
    });

    it('running exclude seeding twice does not duplicate entries', async () => {
      const repoPath = await makeTempRepo();
      await adapter.seedArtifactExcludes(repoPath);
      await adapter.seedArtifactExcludes(repoPath);

      const gitCommonDir = await git(repoPath, ['rev-parse', '--git-common-dir']);
      const excludeFile = isAbsolute(gitCommonDir)
        ? join(gitCommonDir, 'info', 'exclude')
        : resolve(repoPath, gitCommonDir, 'info', 'exclude');
      const content = await readFile(excludeFile, 'utf8');

      const lines = content
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const expectedPatterns = orchestratorExcludePatterns();

      for (const pattern of expectedPatterns) {
        const occurrences = lines.filter((l) => l === pattern).length;
        expect(occurrences).toBe(1);
      }
    });

    it('after seeding, a root diff.patch and one canonical artifact are invisible to git ls-files --others --exclude-standard', async () => {
      const repoPath = await makeTempRepo();
      await adapter.seedArtifactExcludes(repoPath);

      const patchFile = join(repoPath, 'diff.patch');
      const artifactFile = join(repoPath, 'implementation-log.md');

      await writeFile(patchFile, 'some patch content\n');
      await writeFile(artifactFile, 'some implementation log content\n');

      const untracked = await git(repoPath, ['ls-files', '--others', '--exclude-standard']);
      expect(untracked).toBe('');
    });
  });

  describe('cleanOrchestratorArtifacts()', () => {
    it('cleanup unstages and removes a staged canonical artifact', async () => {
      const repoPath = await makeTempRepo();
      const artifactFile = join(repoPath, 'validation.result');
      await writeFile(artifactFile, 'staged content\n');

      await git(repoPath, ['add', 'validation.result']);
      const stagedBefore = await git(repoPath, ['diff', '--cached', '--name-only']);
      expect(stagedBefore).toContain('validation.result');

      await adapter.cleanOrchestratorArtifacts(repoPath);

      const stagedAfter = await git(repoPath, ['diff', '--cached', '--name-only']);
      expect(stagedAfter).not.toContain('validation.result');

      const { access: fsAccess } = await import('node:fs/promises');
      await expect(fsAccess(artifactFile)).rejects.toThrow();
    });

    it('cleanup removes untracked canonical artifacts from worktree root', async () => {
      const repoPath = await makeTempRepo();
      const artifactFile = join(repoPath, 'validation.result');
      await writeFile(artifactFile, 'untracked content\n');

      await adapter.cleanOrchestratorArtifacts(repoPath);

      const { access: fsAccess } = await import('node:fs/promises');
      await expect(fsAccess(artifactFile)).rejects.toThrow();
    });

    it('cleanup removes committed artifacts and commits the removal when baseBranch is provided', async () => {
      const repoPath = await makeTempRepo();
      const baseBranch = 'main';

      // Create a branch off baseBranch
      await git(repoPath, ['checkout', '-b', 'ai/work-branch']);

      const artifactFile = join(repoPath, 'implementation-log.md');
      await writeFile(artifactFile, 'committed content\n');

      await git(repoPath, ['add', 'implementation-log.md']);
      await git(repoPath, ['commit', '-m', 'commit implementation-log.md']);

      // Verify implementation-log.md is committed in current branch relative to baseBranch
      const diffBefore = await git(repoPath, ['diff', `${baseBranch}...HEAD`, '--name-only']);
      expect(diffBefore).toContain('implementation-log.md');

      await adapter.cleanOrchestratorArtifacts(repoPath, baseBranch);

      // Verify it's no longer present on filesystem
      const { access: fsAccess } = await import('node:fs/promises');
      await expect(fsAccess(artifactFile)).rejects.toThrow();

      // Verify it has been removed and committed on the current branch
      const diffAfter = await git(repoPath, ['diff', `${baseBranch}...HEAD`, '--name-only']);
      expect(diffAfter).not.toContain('implementation-log.md');
    });

    it('cleanup does not remove committed artifacts when baseBranch is omitted', async () => {
      const repoPath = await makeTempRepo();

      const artifactFile = join(repoPath, 'validation.result');
      await writeFile(artifactFile, 'committed content\n');

      await git(repoPath, ['add', 'validation.result']);
      await git(repoPath, ['commit', '-m', 'commit validation.result']);

      // Verify validation.result is tracked
      const trackedBefore = await git(repoPath, ['ls-files', 'validation.result']);
      expect(trackedBefore).toContain('validation.result');

      await adapter.cleanOrchestratorArtifacts(repoPath);

      // Verify it is still present on filesystem
      const { access: fsAccess } = await import('node:fs/promises');
      await expect(fsAccess(artifactFile)).resolves.not.toThrow();

      // Verify it remains in git tracking
      const trackedAfter = await git(repoPath, ['ls-files', 'validation.result']);
      expect(trackedAfter).toContain('validation.result');
    });
  });
});
