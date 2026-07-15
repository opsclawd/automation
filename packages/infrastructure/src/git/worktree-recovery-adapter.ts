import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  WorktreeRecoveryPort,
  PrepareWorktreeRecoveryInput,
  WorktreeRecoveryOutcome,
} from '@ai-sdlc/application/ports';
import { TrackedSourceDriftError } from '@ai-sdlc/application/ports';
import { GitWorktreeAdapter } from './git-worktree-adapter.js';
import { git } from './git-runner.js';

export class WorktreeRecoveryAdapter implements WorktreeRecoveryPort {
  private readonly gitAdapter = new GitWorktreeAdapter();

  async prepare(input: PrepareWorktreeRecoveryInput): Promise<WorktreeRecoveryOutcome> {
    const { repoId, runId, worktreePath, baseRef, quarantineRoot } = input;

    try {
      await this.gitAdapter.resetWorktreeIfClean(worktreePath, baseRef);
      return { safe: true, action: 'reset', path: worktreePath };
    } catch (resetError) {
      if (!(resetError instanceof TrackedSourceDriftError)) {
        return {
          safe: false,
          action: 'blocked',
          path: worktreePath,
          error: `reset failed: ${resetError instanceof Error ? resetError.message : String(resetError)}`,
        };
      }

      const quarantinePath = await this._computeQuarantinePath(
        repoId,
        runId,
        worktreePath,
        quarantineRoot,
      );

      try {
        await this._moveToQuarantine(worktreePath, quarantinePath);
        return { safe: true, action: 'quarantined', path: worktreePath };
      } catch (quarantineError) {
        return {
          safe: false,
          action: 'blocked',
          path: worktreePath,
          error: `reset and quarantine both failed: ${quarantineError instanceof Error ? quarantineError.message : String(quarantineError)}`,
        };
      }
    }
  }

  async _computeQuarantinePath(
    repoId: string,
    runId: string,
    worktreePath: string,
    quarantineRoot: string,
  ): Promise<string> {
    const worktreeName = worktreePath.split('/').pop() ?? worktreePath;
    return join(quarantineRoot, `${repoId}/${runId}/${worktreeName}`);
  }

  async _moveToQuarantine(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true });
    const gitCommonDir = await git(from, ['rev-parse', '--git-common-dir']);
    const baseRepoPath = dirname(gitCommonDir);
    await git(baseRepoPath, ['worktree', 'move', from, to]);
  }
}
