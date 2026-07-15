import { afterEach, describe, expect, it } from 'vitest';
import { access, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../git-runner.js';
import { makeTempRepo, getTempDirs, clearTempDirs } from './helpers.js';
import type { RepositoryId, RunId } from '@ai-sdlc/domain';
import { RepositoryId as RepositoryIdCtor, RunId as RunIdCtor } from '@ai-sdlc/domain';

const RepositoryId = RepositoryIdCtor as (v: string) => RepositoryId;
const RunId = RunIdCtor as (v: string) => RunId;

describe('WorktreeRecoveryAdapter', () => {
  async function makeWorktreePath(repoPath: string, suffix: string): Promise<string> {
    const base = repoPath.replace('/.git', '').replace('.git', '');
    return `${base}-wt-${suffix}`;
  }

  afterEach(async () => {
    const dirs = getTempDirs();
    clearTempDirs();
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  describe('clean recovery awaits reset before reporting reset', () => {
    it('reports safe:true with action=reset when worktree is clean and reset succeeds', async () => {
      const repoPath = await makeTempRepo();
      const worktreePath = await makeWorktreePath(repoPath, 'clean-test');

      await git(repoPath, ['worktree', 'add', worktreePath, '-b', 'test-branch']);

      const { WorktreeRecoveryAdapter } = await import('../worktree-recovery-adapter.js');
      const adapter = new WorktreeRecoveryAdapter();

      const repoId = RepositoryId('repo-clean-reset');
      const runId = RunId('run-clean-reset');
      const baseRef = 'main';
      const quarantineRoot = join(repoPath, 'quarantine');

      const result = await adapter.prepare({
        repoId,
        runId,
        worktreePath,
        baseRef,
        quarantineRoot,
      });

      expect(result.safe).toBe(true);
      expect(result.action).toBe('reset');
      expect(result.path).toBe(worktreePath);
    });

    it('does not quarantine when reset succeeds on clean worktree', async () => {
      const repoPath = await makeTempRepo();
      const worktreePath = await makeWorktreePath(repoPath, 'clean-no-quarantine');

      await git(repoPath, ['worktree', 'add', worktreePath, '-b', 'test-branch']);

      const { WorktreeRecoveryAdapter } = await import('../worktree-recovery-adapter.js');
      const adapter = new WorktreeRecoveryAdapter();

      const repoId = RepositoryId('repo-clean-no-q');
      const runId = RunId('run-clean-no-q');
      const quarantineRoot = join(repoPath, 'quarantine');

      await adapter.prepare({
        repoId,
        runId,
        worktreePath,
        baseRef: 'main',
        quarantineRoot,
      });

      await expect(access(quarantineRoot)).rejects.toThrow();
    });
  });

  describe('unsafe accessible worktree moves to repository quarantine', () => {
    it('quarantines worktree when tracked drift (uncommitted changes) is detected', async () => {
      const repoPath = await makeTempRepo();
      const worktreePath = await makeWorktreePath(repoPath, 'unsafe-test');

      await git(repoPath, ['worktree', 'add', worktreePath, '-b', 'test-branch']);
      await writeFile(join(worktreePath, 'drifted.txt'), 'drifted content\n');
      await git(worktreePath, ['add', 'drifted.txt']);

      const { WorktreeRecoveryAdapter } = await import('../worktree-recovery-adapter.js');
      const adapter = new WorktreeRecoveryAdapter();

      const repoId = RepositoryId('repo-unsafe');
      const runId = RunId('run-unsafe');
      const quarantineRoot = join(repoPath, 'quarantine');

      const result = await adapter.prepare({
        repoId,
        runId,
        worktreePath,
        baseRef: 'main',
        quarantineRoot,
      });

      expect(result.safe).toBe(true);
      expect(result.action).toBe('quarantined');
      expect(result.path).toBe(worktreePath);

      const expectedQuarantinePath = join(
        quarantineRoot,
        `repo-unsafe/run-unsafe/${worktreePath.split('/').pop()}`,
      );
      await expect(access(expectedQuarantinePath)).resolves.not.toThrow();
    });

    it('creates quarantine root directory if it does not exist', async () => {
      const repoPath = await makeTempRepo();
      const worktreePath = await makeWorktreePath(repoPath, 'quarantine-mkdir-test');

      await git(repoPath, ['worktree', 'add', worktreePath, '-b', 'test-branch']);
      await writeFile(join(worktreePath, 'drifted.txt'), 'drifted content\n');
      await git(worktreePath, ['add', 'drifted.txt']);

      const { WorktreeRecoveryAdapter } = await import('../worktree-recovery-adapter.js');
      const adapter = new WorktreeRecoveryAdapter();

      const repoId = RepositoryId('repo-q-mkdir');
      const runId = RunId('run-q-mkdir');
      const quarantineRoot = join(repoPath, 'non-existent/quarantine');

      const result = await adapter.prepare({
        repoId,
        runId,
        worktreePath,
        baseRef: 'main',
        quarantineRoot,
      });

      expect(result.safe).toBe(true);
      expect(result.action).toBe('quarantined');
      await expect(access(quarantineRoot)).resolves.not.toThrow();
    });
  });

  describe('repeat quarantine preparation is idempotent', () => {
    it('returns already quarantined without error when called twice on same worktree', async () => {
      const repoPath = await makeTempRepo();
      const worktreePath = await makeWorktreePath(repoPath, 'idempotent-test');

      await git(repoPath, ['worktree', 'add', worktreePath, '-b', 'test-branch']);
      await writeFile(join(worktreePath, 'drifted.txt'), 'drifted content\n');
      await git(worktreePath, ['add', 'drifted.txt']);

      const { WorktreeRecoveryAdapter } = await import('../worktree-recovery-adapter.js');
      const adapter = new WorktreeRecoveryAdapter();

      const repoId = RepositoryId('repo-idempotent');
      const runId = RunId('run-idempotent');
      const quarantineRoot = join(repoPath, 'quarantine');

      const result1 = await adapter.prepare({
        repoId,
        runId,
        worktreePath,
        baseRef: 'main',
        quarantineRoot,
      });

      expect(result1.safe).toBe(true);
      expect(result1.action).toBe('quarantined');

      const result2 = await adapter.prepare({
        repoId,
        runId,
        worktreePath: quarantineRoot,
        baseRef: 'main',
        quarantineRoot,
      });

      expect(result2.safe).toBe(true);
      expect(result2.action).toBe('reset');
    });
  });

  describe('failed reset and quarantine reports blocked without deleting source state', () => {
    it('returns blocked when both reset and quarantine fail', async () => {
      const repoPath = await makeTempRepo();
      const worktreePath = await makeWorktreePath(repoPath, 'blocked-test');

      await git(repoPath, ['worktree', 'add', worktreePath, '-b', 'test-branch']);
      await writeFile(join(worktreePath, 'drifted.txt'), 'drifted content\n');
      await git(worktreePath, ['add', 'drifted.txt']);

      const { WorktreeRecoveryAdapter } = await import('../worktree-recovery-adapter.js');

      let renameAttempted = false;
      class FailingRenameAdapter extends WorktreeRecoveryAdapter {
        async _renameToQuarantine(_from: string, _to: string): Promise<void> {
          renameAttempted = true;
          throw new Error('Simulated rename failure');
        }
      }

      const adapter = new FailingRenameAdapter();

      const repoId = RepositoryId('repo-blocked');
      const runId = RunId('run-blocked');
      const quarantineRoot = join(repoPath, 'quarantine');

      const result = await adapter.prepare({
        repoId,
        runId,
        worktreePath,
        baseRef: 'main',
        quarantineRoot,
      });

      expect(result.safe).toBe(false);
      expect(result.action).toBe('blocked');
      expect(result.error).toBeTruthy();
      expect(renameAttempted).toBe(true);

      await expect(access(worktreePath)).resolves.not.toThrow();
    });
  });
});
