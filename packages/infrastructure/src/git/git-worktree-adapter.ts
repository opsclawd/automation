import { access } from 'node:fs/promises';
import type { CreateWorktreeInput, GitPort, PushInput } from '@ai-sdlc/application/ports';
import { git } from './git-runner.js';

export class GitWorktreeAdapter implements GitPort {
  async createWorktree(input: CreateWorktreeInput): Promise<void> {
    const { repoLocalBasePath, worktreePath, branch, baseBranch } = input;

    try {
      await access(worktreePath);
      return;
    } catch {
      // path absent, proceed with creation
    }

    let branchExists = false;
    try {
      await git(repoLocalBasePath, ['rev-parse', '--verify', branch]);
      branchExists = true;
    } catch {
      // branch does not exist yet
    }

    if (branchExists) {
      await git(repoLocalBasePath, ['worktree', 'add', worktreePath, branch]);
    } else {
      await git(repoLocalBasePath, ['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
    }
  }

  async removeWorktree(_worktreePath: string): Promise<void> {
    throw new Error('not implemented');
  }

  async currentBranch(_cwd: string): Promise<string> {
    throw new Error('not implemented');
  }

  async headCommitSha(_cwd: string): Promise<string> {
    throw new Error('not implemented');
  }

  async headCommitShaOf(_cwd: string): Promise<string | undefined> {
    throw new Error('not implemented');
  }

  async resetHard(_cwd: string, _commitSha: string): Promise<void> {
    throw new Error('not implemented');
  }

  async diff(_cwd: string, _base: string, _head?: string): Promise<string> {
    throw new Error('not implemented');
  }

  async commit(_cwd: string, _message: string): Promise<string> {
    throw new Error('not implemented');
  }

  async push(_input: PushInput): Promise<void> {
    throw new Error('not implemented');
  }

  async remoteRef(_input: {
    cwd: string;
    remote: string;
    ref: string;
  }): Promise<string | undefined> {
    throw new Error('not implemented');
  }

  async isAncestor(_cwd: string, _ancestor: string, _descendant: string): Promise<boolean> {
    throw new Error('not implemented');
  }

  async logBetween(_cwd: string, _base: string, _head: string): Promise<string[]> {
    throw new Error('not implemented');
  }

  async cleanUntracked(_cwd: string): Promise<void> {
    throw new Error('not implemented');
  }
}
