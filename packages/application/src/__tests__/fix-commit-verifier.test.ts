import { describe, it, expect } from 'vitest';
import { verifyFixCommit } from '../fix-commit-verifier.js';
import type { GitPort } from '../ports/git-port.js';

function makeGit(opts: {
  headSha: string | (() => Promise<string>);
  statusOutput: string | (() => Promise<string>);
}): GitPort {
  return {
    createWorktree: async () => undefined,
    removeWorktree: async () => undefined,
    currentBranch: async () => 'main',
    headCommitSha: async () =>
      typeof opts.headSha === 'string' ? opts.headSha : await opts.headSha(),
    resetHard: async () => undefined,
    diff: async () => '',
    diffStat: async () => '',
    commit: async () => '',
    push: async () => undefined,
    remoteRef: async () => undefined,
    isAncestor: async () => true,
    logBetween: async () => [],
    cleanUntracked: async () => undefined,
    headCommitShaOf: async () => undefined,
    status: async () =>
      typeof opts.statusOutput === 'string' ? opts.statusOutput : await opts.statusOutput(),
    resetWorktreeIfClean: async () => undefined,
  };
}

describe('verifyFixCommit', () => {
  it('returns advanced when HEAD moved past expectedHead', async () => {
    const git = makeGit({ headSha: 'after', statusOutput: '' });
    const result = await verifyFixCommit({ git, cwd: '/wt', expectedHead: 'before' });
    expect(result.kind).toBe('advanced');
    if (result.kind === 'advanced') {
      expect(result.headAfterFix).toBe('after');
      expect(result.statusOutput).toBe('');
    }
  });

  it('returns uncommitted_changes when HEAD advanced AND status is non-empty', async () => {
    const git = makeGit({
      headSha: 'after',
      statusOutput: ' M packages/foo.ts\n',
    });
    const result = await verifyFixCommit({ git, cwd: '/wt', expectedHead: 'before' });
    expect(result.kind).toBe('uncommitted_changes');
    if (result.kind === 'uncommitted_changes') {
      expect(result.headAfterFix).toBe('after');
      expect(result.dirtyFiles).toEqual([' M packages/foo.ts']);
    }
  });

  it('returns uncommitted_changes when HEAD unchanged AND status is non-empty', async () => {
    const git = makeGit({
      headSha: 'same',
      statusOutput: ' M packages/foo.ts\n M README.md\n',
    });
    const result = await verifyFixCommit({ git, cwd: '/wt', expectedHead: 'same' });
    expect(result.kind).toBe('uncommitted_changes');
    if (result.kind === 'uncommitted_changes') {
      expect(result.dirtyFiles).toEqual([' M packages/foo.ts', ' M README.md']);
    }
  });

  it('returns no_commit_claimed when HEAD unchanged AND status is empty', async () => {
    const git = makeGit({ headSha: 'same', statusOutput: '' });
    const result = await verifyFixCommit({ git, cwd: '/wt', expectedHead: 'same' });
    expect(result.kind).toBe('no_commit_claimed');
  });

  it('returns verification_error when headCommitSha throws', async () => {
    const git = makeGit({
      headSha: async () => {
        throw new Error('rev-parse exploded');
      },
      statusOutput: '',
    });
    const result = await verifyFixCommit({ git, cwd: '/wt', expectedHead: 'same' });
    expect(result.kind).toBe('verification_error');
    if (result.kind === 'verification_error') {
      expect(result.error).toMatch(/rev-parse exploded/);
    }
  });

  it('returns verification_error when status throws', async () => {
    const git = makeGit({
      headSha: 'same',
      statusOutput: async () => {
        throw new Error('not a git repo');
      },
    });
    const result = await verifyFixCommit({ git, cwd: '/wt', expectedHead: 'same' });
    expect(result.kind).toBe('verification_error');
    if (result.kind === 'verification_error') {
      expect(result.error).toMatch(/not a git repo/);
    }
  });
});
