import { beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

import { GitWorktreeAdapter } from '../git-worktree-adapter.js';

describe('GitWorktreeAdapter stdin commit transport', () => {
  beforeEach(() => {
    execaMock.mockReset();
    execaMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '0123456789012345678901234567890123456789\n' });
  });

  it('commit sends the exact message to git commit -F - over stdin', async () => {
    const message = 'feat: subject\n\n- body item\n- literal \\n stays literal';
    await new GitWorktreeAdapter().commit('/repo', message);

    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      'git',
      ['commit', '-F', '-'],
      expect.objectContaining({ cwd: '/repo', input: message }),
    );
  });

  it('amend sends the exact message to git commit --amend -F - over stdin', async () => {
    const message = 'fix: subject\n\nbody';
    await new GitWorktreeAdapter().amendCommitMessage('/repo', message);

    expect(execaMock).toHaveBeenNthCalledWith(
      1,
      'git',
      ['commit', '--amend', '-F', '-'],
      expect.objectContaining({ cwd: '/repo', input: message }),
    );
  });
});
