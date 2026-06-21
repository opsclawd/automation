import { access, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CreateWorktreeInput, GitPort, PushInput } from '@ai-sdlc/application/ports';
import { git, GitFailedError } from './git-runner.js';

export class GitWorktreeAdapter implements GitPort {
  async createWorktree(input: CreateWorktreeInput): Promise<void> {
    const { repoLocalBasePath, worktreePath, branch, baseBranch } = input;

    try {
      await access(worktreePath);
      // Path exists — verify it's a valid independent worktree, not a stale directory
      const topLevel = await git(worktreePath, ['rev-parse', '--show-toplevel']);
      if (topLevel === worktreePath) return;
      // Resolved to a parent directory — treat as stale
      await rm(worktreePath, { recursive: true, force: true });
    } catch {
      await rm(worktreePath, { recursive: true, force: true });
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

  async removeWorktree(worktreePath: string): Promise<void> {
    let baseRepoPath: string;
    try {
      const gitCommonDir = await git(worktreePath, ['rev-parse', '--git-common-dir']);
      baseRepoPath = dirname(gitCommonDir);
    } catch {
      await rm(worktreePath, { recursive: true, force: true });
      return;
    }

    try {
      await git(baseRepoPath, ['worktree', 'remove', '--force', worktreePath]);
    } catch {
      await rm(worktreePath, { recursive: true, force: true });
      await git(baseRepoPath, ['worktree', 'prune']);
    }
  }

  async currentBranch(cwd: string): Promise<string> {
    return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  async headCommitSha(cwd: string): Promise<string> {
    return git(cwd, ['rev-parse', 'HEAD']);
  }

  async headCommitShaOf(cwd: string): Promise<string | undefined> {
    try {
      return await git(cwd, ['rev-parse', 'HEAD']);
    } catch {
      return undefined;
    }
  }

  async resetHard(cwd: string, commitSha: string): Promise<void> {
    await git(cwd, ['reset', '--hard', commitSha]);
  }

  async diff(cwd: string, base: string, head?: string): Promise<string> {
    return head ? git(cwd, ['diff', base, head]) : git(cwd, ['diff', base]);
  }

  async commit(cwd: string, message: string): Promise<string> {
    await git(cwd, ['commit', '-m', message]);
    return git(cwd, ['rev-parse', 'HEAD']);
  }

  async push(input: PushInput): Promise<void> {
    const { cwd, branch, remote = 'origin' } = input;
    await git(cwd, ['push', remote, branch]);
  }

  async remoteRef(input: {
    cwd: string;
    remote: string;
    ref: string;
  }): Promise<string | undefined> {
    try {
      const out = await git(input.cwd, ['ls-remote', '--exit-code', input.remote, input.ref]);
      const lines = out.split('\n').filter(Boolean);
      if (lines.length === 0) return undefined;

      if (input.ref.startsWith('refs/')) {
        const exact = lines.find((l) => l.endsWith(`\t${input.ref}`));
        return exact?.split('\t')[0] ?? undefined;
      }

      const branchLine = lines.find((l) => l.endsWith(`\trefs/heads/${input.ref}`));
      return (branchLine ?? lines[0]!).split('\t')[0];
    } catch {
      return undefined;
    }
  }

  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
      return true;
    } catch (err) {
      if (err instanceof GitFailedError && err.stderr.trim() === '') {
        return false;
      }
      throw err;
    }
  }

  async logBetween(cwd: string, base: string, head: string): Promise<string[]> {
    const out = await git(cwd, ['log', '--format=%s', `${base}..${head}`]);
    return out ? out.split('\n').filter(Boolean) : [];
  }

  async cleanUntracked(cwd: string): Promise<void> {
    await git(cwd, ['clean', '-fd']);
  }
}
