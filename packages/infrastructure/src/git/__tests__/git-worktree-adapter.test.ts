import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
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
  const sampleExcludePatterns = Object.freeze([
    'validation.headsha',
    'review-fix-plan.json',
    'review-task-manifest.json',
    'review-triage.md',
    'code-review.md',
    'review.md',
    'task-manifest.json',
    'implementation-log.md',
    'arbiter-result.json',
    'review-loop-history.json',
    'implement-step-history-*.json',
    'compound-draft.md',
    'validation.result',
    'result.json',
    'fix-validate-done.marker',
    'plan-review-passed.marker',
    '*.patch',
    'issue.md',
    'design.md',
    'plan.md',
  ]);
  const adapter = new GitWorktreeAdapter(sampleExcludePatterns);

  describe('seedArtifactExcludes()', () => {
    it('writes every canonical artifact and *.patch', async () => {
      const repoPath = await makeTempRepo();
      await adapter.seedArtifactExcludes(repoPath);

      const gitCommonDir = await git(repoPath, ['rev-parse', '--git-common-dir']);
      const excludeFile = isAbsolute(gitCommonDir)
        ? join(gitCommonDir, 'info', 'exclude')
        : resolve(repoPath, gitCommonDir, 'info', 'exclude');
      const content = await readFile(excludeFile, 'utf8');

      const expectedPatterns = sampleExcludePatterns;
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
      const expectedPatterns = sampleExcludePatterns;

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

    it('cleanup removes untracked wildcard artifacts from worktree root', async () => {
      const repoPath = await makeTempRepo();
      const artifactFile = join(repoPath, 'implement-step-history-3.json');
      await writeFile(artifactFile, 'untracked content\n');

      await adapter.cleanOrchestratorArtifacts(repoPath);

      const { access: fsAccess } = await import('node:fs/promises');
      await expect(fsAccess(artifactFile)).rejects.toThrow();
    });

    it('cleanup removes untracked canonical and wildcard artifacts in subdirectories', async () => {
      const repoPath = await makeTempRepo();
      await mkdir(join(repoPath, 'sub', 'nested'), { recursive: true });
      const nestedArtifact = join(repoPath, 'sub', 'nested', 'validation.result');
      const nestedWildcard = join(repoPath, 'sub', 'nested', 'implement-step-history-4.json');
      const nestedPatch = join(repoPath, 'sub', 'fix.patch');

      await writeFile(nestedArtifact, 'nested artifact\n');
      await writeFile(nestedWildcard, 'nested wildcard\n');
      await writeFile(nestedPatch, 'nested patch\n');

      await adapter.cleanOrchestratorArtifacts(repoPath);

      const { access: fsAccess } = await import('node:fs/promises');
      await expect(fsAccess(nestedArtifact)).rejects.toThrow();
      await expect(fsAccess(nestedWildcard)).rejects.toThrow();
      await expect(fsAccess(nestedPatch)).rejects.toThrow();
    });

    it('cleanup removes untracked artifacts in subdirectories after seedArtifactExcludes', async () => {
      const repoPath = await makeTempRepo();
      await adapter.seedArtifactExcludes(repoPath);

      await mkdir(join(repoPath, 'packages', 'sub'), { recursive: true });
      const nestedArtifact = join(repoPath, 'packages', 'sub', 'validation.result');
      await writeFile(nestedArtifact, 'nested excluded artifact\n');

      await adapter.cleanOrchestratorArtifacts(repoPath);

      const { access: fsAccess } = await import('node:fs/promises');
      await expect(fsAccess(nestedArtifact)).rejects.toThrow();
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

    it('cleanup does not remove files inside ignored directories like node_modules', async () => {
      const repoPath = await makeTempRepo();
      await writeFile(join(repoPath, '.gitignore'), 'node_modules/\n');
      await git(repoPath, ['add', '.gitignore']);
      await git(repoPath, ['commit', '-m', 'add .gitignore']);

      await mkdir(join(repoPath, 'node_modules', 'some-pkg'), { recursive: true });
      const pkgFile = join(repoPath, 'node_modules', 'some-pkg', 'index.js');
      await writeFile(pkgFile, 'module.exports = {};\n');

      const artifactFile = join(repoPath, 'validation.result');
      await writeFile(artifactFile, 'artifact content\n');

      await adapter.cleanOrchestratorArtifacts(repoPath);

      const { access: fsAccess } = await import('node:fs/promises');
      // Artifact must be removed
      await expect(fsAccess(artifactFile)).rejects.toThrow();
      // Ignored directory content must NOT be removed
      await expect(fsAccess(pkgFile)).resolves.not.toThrow();
    });

    it('cleanup handles untracked artifacts and patches with spaces in directory and file names', async () => {
      const repoPath = await makeTempRepo();
      await mkdir(join(repoPath, 'nested folder with spaces'), { recursive: true });
      const spacedArtifact = join(repoPath, 'nested folder with spaces', 'validation.result');
      const spacedPatch = join(repoPath, 'nested folder with spaces', 'fix with spaces.patch');

      await writeFile(spacedArtifact, 'spaced artifact\n');
      await writeFile(spacedPatch, 'spaced patch\n');

      await adapter.cleanOrchestratorArtifacts(repoPath);

      const { access: fsAccess } = await import('node:fs/promises');
      await expect(fsAccess(spacedArtifact)).rejects.toThrow();
      await expect(fsAccess(spacedPatch)).rejects.toThrow();
    });

    it('cleanup handles staged and committed artifacts with spaces in paths', async () => {
      const repoPath = await makeTempRepo();
      const baseBranch = 'main';
      await git(repoPath, ['checkout', '-b', 'ai/space-branch']);

      await mkdir(join(repoPath, 'space dir'), { recursive: true });
      const stagedArtifact = join(repoPath, 'space dir', 'fix spaced.patch');
      const committedArtifact = join(repoPath, 'space dir', 'implementation-log.md');

      await writeFile(committedArtifact, 'committed with spaces\n');
      await git(repoPath, ['add', 'space dir/implementation-log.md']);
      await git(repoPath, ['commit', '-m', 'commit spaced artifact']);

      await writeFile(stagedArtifact, 'staged with spaces\n');
      await git(repoPath, ['add', 'space dir/fix spaced.patch']);

      await adapter.cleanOrchestratorArtifacts(repoPath, baseBranch);

      const { access: fsAccess } = await import('node:fs/promises');
      await expect(fsAccess(stagedArtifact)).rejects.toThrow();
      await expect(fsAccess(committedArtifact)).rejects.toThrow();

      const diffAfter = await git(repoPath, ['diff', `${baseBranch}...HEAD`, '--name-only']);
      expect(diffAfter).not.toContain('space dir/implementation-log.md');
    });

    it('cleanup removes directory artifacts matching exclude patterns without EISDIR error', async () => {
      const dirAdapter = new GitWorktreeAdapter(['custom-artifact-dir', '.scratch-cache']);
      const repoPath = await makeTempRepo();
      await dirAdapter.seedArtifactExcludes(repoPath);

      const rootArtifactDir = join(repoPath, 'custom-artifact-dir');
      await mkdir(join(rootArtifactDir, 'nested'), { recursive: true });
      await writeFile(join(rootArtifactDir, 'nested', 'file.txt'), 'content\n');

      await mkdir(join(repoPath, 'sub', '.scratch-cache'), { recursive: true });
      await writeFile(join(repoPath, 'sub', '.scratch-cache', 'item.json'), '{}\n');

      await dirAdapter.cleanOrchestratorArtifacts(repoPath);

      const { access: fsAccess } = await import('node:fs/promises');
      await expect(fsAccess(rootArtifactDir)).rejects.toThrow();
      await expect(fsAccess(join(repoPath, 'sub', '.scratch-cache'))).rejects.toThrow();
    });

    it('cleanup does not match wildcards across directory boundaries', async () => {
      const wildcardAdapter = new GitWorktreeAdapter(['implement-step-history-*.json']);
      const repoPath = await makeTempRepo();

      // Create a file in a directory whose path starts with the pattern prefix
      const nestedDir = join(repoPath, 'implement-step-history-archive');
      await mkdir(nestedDir, { recursive: true });
      const nestedFile = join(nestedDir, 'data.json');
      await writeFile(nestedFile, '{"source": true}\n');

      await wildcardAdapter.cleanOrchestratorArtifacts(repoPath);

      const { access: fsAccess } = await import('node:fs/promises');
      // The legitimate source file must NOT be deleted
      await expect(fsAccess(nestedFile)).resolves.toBeUndefined();
    });

    it('escapes special regex characters including question mark', async () => {
      const questionAdapter = new GitWorktreeAdapter(['artifact-?.md']);
      const repoPath = await makeTempRepo();

      const nonMatchingFile = join(repoPath, 'artifact-.md');
      await writeFile(nonMatchingFile, 'content\n');

      await questionAdapter.cleanOrchestratorArtifacts(repoPath);

      const { access: fsAccess } = await import('node:fs/promises');
      // If ? was not escaped, it would make '-' optional and match 'artifact-.md'
      await expect(fsAccess(nonMatchingFile)).resolves.toBeUndefined();
    });
  });
});

describe('status()', () => {
  it('returns empty string when worktree is clean', async () => {
    const repo = await makeTempRepo();
    const result = await adapter.status(repo);
    expect(result).toBe('');
  });

  it('returns porcelain line for an untracked file', async () => {
    const repo = await makeTempRepo();
    await writeFile(join(repo, 'untracked.txt'), 'new\n');
    const result = await adapter.status(repo);
    expect(result).toContain('?? untracked.txt');
  });

  it('addAll() stages untracked and modified files', async () => {
    const repo = await makeTempRepo();
    await writeFile(join(repo, 'README.md'), 'modified\n');
    await writeFile(join(repo, 'new.txt'), 'new\n');

    const statusBefore = await adapter.status(repo);
    // Unstaged modification is " M" (space in column 1, M in column 2).
    // Note: adapter.status() trims the whole output, but internal spaces remain.
    expect(statusBefore).toContain('M README.md');
    expect(statusBefore).toContain('?? new.txt');

    await adapter.addAll(repo);

    const statusAfter = await adapter.status(repo);
    // Staged modification is "M " (M in column 1, space in column 2).
    // Porcelain output is "XY path", so "M  path" for staged.
    expect(statusAfter).toContain('M  README.md');
    expect(statusAfter).toContain('A  new.txt');
    // porcelain status M  means staged modification,  M (with space before) means unstaged.
    // porcelain status M  means staged modification,  M (with space before) means unstaged.
    // wait, git status --porcelain:
    // "M " = staged modification
    // " M" = unstaged modification
    // "MM" = both staged and unstaged modification
    // "A " = added to index
    // "??" = untracked
  });

  it('returns modified marker for a staged tracked-file change', async () => {
    const repo = await makeTempRepo();
    await writeFile(join(repo, 'README.md'), 'modified\n');
    await git(repo, ['add', 'README.md']);
    const result = await adapter.status(repo);
    expect(result).toContain('M  README.md');
  });
});

describe('renamedFiles()', () => {
  it('detects file renames between two commits', async () => {
    const repo = await makeTempRepo();
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'old-name.ts'), 'export const x = 42;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'add old-name']);
    const midSha = await git(repo, ['rev-parse', 'HEAD']);

    await git(repo, ['mv', 'src/old-name.ts', 'src/new-name.ts']);
    await git(repo, ['commit', '-m', 'rename old-name to new-name']);
    const finalSha = await git(repo, ['rev-parse', 'HEAD']);

    const renames = await adapter.renamedFiles!(repo, midSha, finalSha);
    expect(renames).toEqual([{ oldPath: 'src/old-name.ts', newPath: 'src/new-name.ts' }]);
  });
});

describe('commit()', () => {
  it('returns current HEAD sha as benign no-op when pre-commit hook refuses an empty commit', async () => {
    const repo = await makeTempRepo();
    // Reset core.hooksPath so repository .git/hooks/pre-commit is used
    await git(repo, ['config', 'core.hooksPath', '.git/hooks']);
    const headShaBefore = await git(repo, ['rev-parse', 'HEAD']);

    // Set up a pre-commit hook that reformats dirty content to match HEAD, re-stages, and exits 1 (refusing empty commit)
    const hookPath = join(repo, '.git', 'hooks', 'pre-commit');
    await writeFile(
      hookPath,
      '#!/bin/sh\n' +
        'printf "initial\\n" > README.md\n' +
        'git add README.md\n' +
        'echo "lint-staged prevented an empty git commit."\n' +
        'exit 42\n',
    );
    const { chmod } = await import('node:fs/promises');
    await chmod(hookPath, 0o755);

    // Stage a file whose dirty content canonicalizes back to HEAD when formatted
    await writeFile(join(repo, 'README.md'), 'initial   \n');
    await git(repo, ['add', 'README.md']);

    // adapter.commit should catch hook refusal, check diff --cached --quiet, find it clean, and return HEAD sha
    const shaAfter = await adapter.commit(repo, 'auto-commit formatting debt');
    expect(shaAfter).toBe(headShaBefore);
  });

  it('rethrows GitFailedError when pre-commit hook fails for a real reason (staged diff is non-empty)', async () => {
    const repo = await makeTempRepo();
    // Reset core.hooksPath so repository .git/hooks/pre-commit is used
    await git(repo, ['config', 'core.hooksPath', '.git/hooks']);

    // Set up a pre-commit hook that exits non-zero due to lint/typecheck error on staged file
    const hookPath = join(repo, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/bin/sh\necho "ESLint found 1 error in staged files"\nexit 42\n');
    const { chmod } = await import('node:fs/promises');
    await chmod(hookPath, 0o755);

    await writeFile(join(repo, 'README.md'), 'real modification\n');
    await git(repo, ['add', 'README.md']);

    await expect(adapter.commit(repo, 'feat: real change')).rejects.toThrow();
  });
});

describe('changedFiles()', () => {
  it('returns normalized paths committed in the requested range', async () => {
    const repo = await makeTempRepo();
    const initialSha = await git(repo, ['rev-parse', 'HEAD']);

    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'changed.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'src', 'renamed.ts'), 'export const b = 2;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'add src files']);
    const committedSha = await git(repo, ['rev-parse', 'HEAD']);

    const files = await adapter.changedFiles!(repo, initialSha, committedSha);
    expect(files).toEqual(['src/changed.ts', 'src/renamed.ts']);
  });

  it('excludes uncommitted working tree changes from the committed range', async () => {
    const repo = await makeTempRepo();
    const initialSha = await git(repo, ['rev-parse', 'HEAD']);

    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'changed.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'src', 'renamed.ts'), 'export const b = 2;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'add src files']);
    const committedSha = await git(repo, ['rev-parse', 'HEAD']);

    await writeFile(join(repo, 'src', 'uncommitted.ts'), 'export const c = 3;\n');

    const files = await adapter.changedFiles!(repo, initialSha, committedSha);
    expect(files).toEqual(['src/changed.ts', 'src/renamed.ts']);
    expect(files).not.toContain('src/uncommitted.ts');
  });

  it('honors the explicit head bound', async () => {
    const repo = await makeTempRepo();
    const initialSha = await git(repo, ['rev-parse', 'HEAD']);

    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'changed.ts'), 'export const a = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'commit 1']);
    const headBoundSha = await git(repo, ['rev-parse', 'HEAD']);

    await writeFile(join(repo, 'src', 'later.ts'), 'export const d = 4;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'commit 2']);

    const files = await adapter.changedFiles!(repo, initialSha, headBoundSha);
    expect(files).toEqual(['src/changed.ts']);
    expect(files).not.toContain('src/later.ts');
  });

  it('returns an empty array for an empty committed range', async () => {
    const repo = await makeTempRepo();
    const committedSha = await git(repo, ['rev-parse', 'HEAD']);

    const files = await adapter.changedFiles!(repo, committedSha, committedSha);
    expect(files).toEqual([]);
  });
});

describe('worktreeFileContent()', () => {
  it('reads uncommitted file content from worktree', async () => {
    const repo = await makeTempRepo();
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'demo.ts'), 'export const val = 42;\n');

    const content = await adapter.worktreeFileContent!(repo, 'src/demo.ts');
    expect(content).toBe('export const val = 42;\n');
  });

  it('reads uncommitted file content from worktree with spaces in path', async () => {
    const repo = await makeTempRepo();
    await mkdir(join(repo, 'src with spaces'), { recursive: true });
    await writeFile(
      join(repo, 'src with spaces', 'file name with spaces.ts'),
      'export const spaced = true;\n',
    );

    const content = await adapter.worktreeFileContent!(
      repo,
      'src with spaces/file name with spaces.ts',
    );
    expect(content).toBe('export const spaced = true;\n');
  });

  it('returns undefined when file does not exist in worktree', async () => {
    const repo = await makeTempRepo();
    const content = await adapter.worktreeFileContent!(repo, 'src/nonexistent.ts');
    expect(content).toBeUndefined();
  });
});
