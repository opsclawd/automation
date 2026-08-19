import { describe, expect, it } from 'vitest';
import type { RunId, RepositoryId, WorkerLease } from '@ai-sdlc/domain';
import { CancelRun } from '../cancel-run.js';
import type { GitPort, WorkerLeasePort, RunAbortPort, LoggerPort } from '../ports.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';

const fixedNow = () => new Date('2026-05-13T19:23:00Z');
const runId = (s: string) => s as RunId;

const noopAbort: RunAbortPort = {
  register: () => {},
  abort: () => Promise.resolve({ status: 'exited' }),
  unregister: () => {},
};
const noopGit = {
  resetHard: () => Promise.resolve(),
  cleanUntracked: () => Promise.resolve(),
  headCommitSha: () => Promise.resolve('sha-123'),
  headCommitShaOf: () => Promise.resolve('sha-123'),
} as GitPort;
const noopLeases: WorkerLeasePort = {
  acquire: () => {
    throw new Error('unexpected');
  },
  heartbeat: () => {},
  release: () => {},
  current: () => undefined,
  reclaimExpired: () => [],
};
const noopFindCwd = () => '/tmp';
const noopFindStartSha = () => 'abc123';
const noopLogger: LoggerPort = { error: () => {} };

function makeCancelRun(deps: Partial<Parameters<typeof CancelRun.prototype.constructor>[0]> = {}) {
  return new CancelRun({
    runRepository: deps.runRepository ?? new FakeRunRepository(),
    runAbort: deps.runAbort ?? noopAbort,
    git: deps.git ?? noopGit,
    leases: deps.leases ?? noopLeases,
    findCwd: deps.findCwd ?? noopFindCwd,
    findStartCommitSha: deps.findStartCommitSha ?? noopFindStartSha,
    logger: deps.logger ?? noopLogger,
    now: deps.now ?? fixedNow,
  });
}

describe('CancelRun', () => {
  it('cancels an active run by runId', async () => {
    const repo = new FakeRunRepository();
    repo.addRun({
      uuid: 'abc-123',
      displayId: 'issue-7-20260513-000000',
      issueNumber: 7,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T19:00:00Z'),
    });
    const usecase = makeCancelRun({ runRepository: repo });
    const res = await usecase.execute({ runId: runId('abc-123'), reason: 'user requested' });
    expect(repo.updates).toHaveLength(1);
    expect(repo.updates[0]!.patch.status).toBe('cancelled');
    expect(repo.updates[0]!.patch.failureReason).toBe('user requested');
    expect(repo.updates[0]!.patch.completedAt).toEqual(fixedNow());
    expect(res).toEqual({
      runId: 'abc-123',
      status: 'cancelled',
      abortStatus: 'exited',
      worktreeReset: true,
      branchSha: 'sha-123',
    });
  });

  it('throws when no run exists for the given runId', async () => {
    const repo = new FakeRunRepository();
    const usecase = makeCancelRun({ runRepository: repo });
    await expect(usecase.execute({ runId: runId('nonexistent') })).rejects.toThrow(/no run found/i);
  });

  it('throws when the run is already terminal', async () => {
    const repo = new FakeRunRepository();
    repo.addRun({
      uuid: 'abc-456',
      displayId: 'issue-3-20260513-000000',
      issueNumber: 3,
      type: 'issue_to_pr',
      status: 'passed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T19:00:00Z'),
    });
    const usecase = makeCancelRun({ runRepository: repo });
    await expect(usecase.execute({ runId: runId('abc-456') })).rejects.toThrow(/already passed/i);
  });

  it('cancels without a reason', async () => {
    const repo = new FakeRunRepository();
    repo.addRun({
      uuid: 'abc-789',
      displayId: 'issue-10-20260513-000000',
      issueNumber: 10,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T19:00:00Z'),
    });
    const usecase = makeCancelRun({ runRepository: repo });
    const res = await usecase.execute({ runId: runId('abc-789') });
    expect(repo.updates[0]!.patch.failureReason).toBeUndefined();
    expect(res.worktreeReset).toBe(true);
  });

  it('skips worktree reset when abort times out', async () => {
    const repo = new FakeRunRepository();
    repo.addRun({
      uuid: 'timeout-run',
      displayId: 'issue-11-20260513-000000',
      issueNumber: 11,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T19:00:00Z'),
    });
    let resetCalled = false;
    const git: GitPort = {
      ...noopGit,
      resetHard: async () => {
        resetCalled = true;
      },
      cleanUntracked: async () => {
        resetCalled = true;
      },
    };
    const runAbort: RunAbortPort = {
      register: () => {},
      abort: async () => ({ status: 'timed_out' }),
      unregister: () => {},
    };
    const usecase = makeCancelRun({ runRepository: repo, git, runAbort });
    const res = await usecase.execute({ runId: runId('timeout-run') });
    expect(resetCalled).toBe(false);
    expect(res).toEqual({
      runId: 'timeout-run',
      status: 'cancelled',
      abortStatus: 'timed_out',
      worktreeReset: false,
    });
  });

  it('marks the run as cancelled via atomicUpdateByUuid', async () => {
    const repo = new FakeRunRepository();
    repo.addRun({
      uuid: 'xyz-001',
      displayId: 'issue-15-20260513-000000',
      issueNumber: 15,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T19:00:00Z'),
    });
    const usecase = makeCancelRun({ runRepository: repo });
    await usecase.execute({ runId: runId('xyz-001'), reason: 'manual override' });
    expect(repo.updates).toHaveLength(1);
    expect(repo.updates[0]!.uuid).toBe('xyz-001');
    expect(repo.updates[0]!.patch.status).toBe('cancelled');
    expect(repo.updates[0]!.patch.failureReason).toBe('manual override');
  });

  it('throws when atomicUpdateByUuid returns false (concurrent cancellation)', async () => {
    const repo = new FakeRunRepository();
    repo.addRun({
      uuid: 'concurrent-cancel',
      displayId: 'issue-8-20260513-000000',
      issueNumber: 8,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T19:00:00Z'),
    });
    repo.atomicUpdateByUuid = () => false;
    const usecase = makeCancelRun({ runRepository: repo });
    await expect(usecase.execute({ runId: runId('concurrent-cancel') })).rejects.toThrow(
      /concurrent modification/i,
    );
  });

  it('returns branchSha and preserves committed history on the branch without resetting to startCommitSha', async () => {
    const repo = new FakeRunRepository();
    repo.addRun({
      uuid: 'history-run',
      displayId: 'issue-54-20260513-000000',
      issueNumber: 54,
      repoId: 'repo-1' as RepositoryId,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: ['read_issue', 'implement', 'fix-validate'],
      startedAt: new Date('2026-05-13T19:00:00Z'),
    });

    const resetHardCalls: Array<{ cwd: string; sha: string }> = [];
    const cleanUntrackedCalls: string[] = [];

    const git: GitPort = {
      createWorktree: async () => {},
      removeWorktree: async () => {},
      currentBranch: async () => 'ai/issue-54',
      headCommitSha: async () => '5f83e8d',
      headCommitShaOf: async () => '5f83e8d',
      resetHard: async (cwd, sha) => {
        resetHardCalls.push({ cwd, sha });
      },
      diff: async () => '',
      commit: async () => '',
      push: async () => {},
      remoteRef: async () => undefined,
      isAncestor: async () => false,
      logBetween: async () => [],
      cleanUntracked: async (cwd) => {
        cleanUntrackedCalls.push(cwd);
      },
    };

    const usecase = makeCancelRun({
      runRepository: repo,
      git,
      findCwd: () => '/tmp/worktree-54',
      findStartCommitSha: () => '2fc18c9', // start commit before implement/review-fix
    });

    const result = await usecase.execute({ runId: runId('history-run'), reason: 'interrupted' });

    expect(result.branchSha).toBe('5f83e8d');
    // Ensure resetHard was called with the current HEAD SHA (5f83e8d) to clean uncommitted changes,
    // NOT with the startCommitSha (2fc18c9) which would discard completed phase commits!
    expect(resetHardCalls).toEqual([{ cwd: '/tmp/worktree-54', sha: '5f83e8d' }]);
    expect(cleanUntrackedCalls).toEqual(['/tmp/worktree-54']);
  });

  describe('ordering', () => {
    it('calls runAbort.abort() before git.resetHard()', async () => {
      const callOrder: string[] = [];
      const runAbort: RunAbortPort = {
        register: () => {},
        abort: () => {
          callOrder.push('abort');
          return Promise.resolve({ status: 'exited' });
        },
        unregister: () => {},
      };
      const git: GitPort = {
        createWorktree: async () => {},
        removeWorktree: async () => {},
        currentBranch: async () => '',
        headCommitSha: async () => 'sha-123',
        headCommitShaOf: async () => 'sha-123',
        resetHard: async () => {
          callOrder.push('reset');
        },
        diff: async () => '',
        commit: async () => '',
        push: async () => {},
        remoteRef: async () => undefined,
        isAncestor: async () => false,
        logBetween: async () => [],
        cleanUntracked: async () => {},
      };
      const leases: WorkerLeasePort = {
        acquire: () => {
          throw new Error('unexpected');
        },
        heartbeat: () => {},
        release: () => {},
        current: () => undefined,
        reclaimExpired: () => [],
      };
      const repo = new FakeRunRepository();
      repo.addRun({
        uuid: 'order-1',
        displayId: 'issue-1-20260513-000000',
        issueNumber: 1,
        repoId: 'repo-1' as RepositoryId,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T19:00:00Z'),
      });
      const usecase = makeCancelRun({
        runRepository: repo,
        runAbort,
        git,
        leases,
        findCwd: () => '/tmp',
        findStartCommitSha: () => 'sha',
      });
      await usecase.execute({ runId: runId('order-1') });
      const abortIdx = callOrder.indexOf('abort');
      const resetIdx = callOrder.indexOf('reset');
      expect(abortIdx).toBeLessThan(resetIdx);
    });

    it('calls git.resetHard() before leases.release()', async () => {
      const callOrder: string[] = [];
      const git: GitPort = {
        createWorktree: async () => {},
        removeWorktree: async () => {},
        currentBranch: async () => '',
        headCommitSha: async () => 'sha-123',
        headCommitShaOf: async () => 'sha-123',
        resetHard: async () => {
          callOrder.push('reset');
        },
        diff: async () => '',
        commit: async () => '',
        push: async () => {},
        remoteRef: async () => undefined,
        isAncestor: async () => false,
        logBetween: async () => [],
        cleanUntracked: async () => {},
      };
      const leaseObj: WorkerLease = {
        repoId: 'repo-1' as RepositoryId,
        workerId: 'w-1' as unknown as WorkerLease['workerId'],
        runId: 'order-2' as unknown as WorkerLease['runId'],
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(),
      };
      const repo = new FakeRunRepository();
      repo.addRun({
        uuid: 'order-2',
        displayId: 'issue-2-20260513-000000',
        issueNumber: 2,
        repoId: 'repo-1' as RepositoryId,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T19:00:00Z'),
      });
      const leases: WorkerLeasePort = {
        acquire: () => {
          throw new Error('unexpected');
        },
        heartbeat: () => {},
        release: () => {
          callOrder.push('release');
        },
        current: () => leaseObj,
        reclaimExpired: () => [],
      };
      const usecase = makeCancelRun({
        runRepository: repo,
        git,
        leases,
        findCwd: () => '/tmp',
        findStartCommitSha: () => 'sha',
      });
      await usecase.execute({ runId: runId('order-2') });
      const resetIdx = callOrder.indexOf('reset');
      const releaseIdx = callOrder.indexOf('release');
      expect(resetIdx).toBeLessThan(releaseIdx);
    });

    it('marks cancelled even when all best-effort steps throw', async () => {
      const repo = new FakeRunRepository();
      repo.addRun({
        uuid: 'best-effort',
        displayId: 'issue-3-20260513-000000',
        issueNumber: 3,
        repoId: 'repo-1' as RepositoryId,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T19:00:00Z'),
      });
      const runAbort: RunAbortPort = {
        register: () => {},
        abort: async () => {
          throw new Error('abort fail');
        },
        unregister: () => {
          throw new Error('unregister fail');
        },
      };
      const git: GitPort = {
        createWorktree: async () => {},
        removeWorktree: async () => {},
        currentBranch: async () => '',
        headCommitSha: async () => 'sha-123',
        resetHard: async () => {
          throw new Error('reset fail');
        },
        diff: async () => '',
        commit: async () => '',
        push: async () => {},
        remoteRef: async () => undefined,
        isAncestor: async () => false,
        logBetween: async () => [],
        cleanUntracked: async () => {},
        headCommitShaOf: async () => 'sha-123',
      };
      const leases: WorkerLeasePort = {
        acquire: () => {
          throw new Error('unexpected');
        },
        heartbeat: () => {},
        release: () => {},
        current: () => {
          throw new Error('lease fail');
        },
        reclaimExpired: () => [],
      };
      const usecase = makeCancelRun({
        runRepository: repo,
        runAbort,
        git,
        leases,
        findCwd: () => {
          throw new Error('cwd fail');
        },
        findStartCommitSha: () => {
          throw new Error('sha fail');
        },
        logger: noopLogger,
        now: fixedNow,
      });
      const res = await usecase.execute({ runId: runId('best-effort') });
      expect(repo.updates).toHaveLength(1);
      expect(repo.updates[0]!.patch.status).toBe('cancelled');
      expect(res.worktreeReset).toBe(false);
    });

    it('marks cancelled when abort throws but other steps proceed', async () => {
      const callOrder: string[] = [];
      const repo = new FakeRunRepository();
      repo.addRun({
        uuid: 'abort-throws',
        displayId: 'issue-4-20260513-000000',
        issueNumber: 4,
        repoId: 'repo-1' as RepositoryId,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T19:00:00Z'),
      });
      const runAbort: RunAbortPort = {
        register: () => {},
        abort: async () => {
          throw new Error('abort fail');
        },
        unregister: () => {},
      };
      const git: GitPort = {
        createWorktree: async () => {},
        removeWorktree: async () => {},
        currentBranch: async () => '',
        headCommitSha: async () => 'sha-123',
        headCommitShaOf: async () => 'sha-123',
        resetHard: async () => {
          callOrder.push('reset');
        },
        diff: async () => '',
        commit: async () => '',
        push: async () => {},
        remoteRef: async () => undefined,
        isAncestor: async () => false,
        logBetween: async () => [],
        cleanUntracked: async () => {},
      };
      const leases: WorkerLeasePort = {
        acquire: () => {
          throw new Error('unexpected');
        },
        heartbeat: () => {},
        release: () => {
          callOrder.push('release');
        },
        current: () => undefined,
        reclaimExpired: () => [],
      };
      const usecase = makeCancelRun({
        runRepository: repo,
        runAbort,
        git,
        leases,
        findCwd: () => '/tmp',
        findStartCommitSha: () => 'sha',
      });
      await usecase.execute({ runId: runId('abort-throws') });
      expect(repo.updates).toHaveLength(1);
      expect(repo.updates[0]!.patch.status).toBe('cancelled');
      expect(callOrder).toContain('reset');
    });

    it('marks cancelled when resetHard throws but other steps proceed', async () => {
      const callOrder: string[] = [];
      const repo = new FakeRunRepository();
      repo.addRun({
        uuid: 'reset-throws',
        displayId: 'issue-5-20260513-000000',
        issueNumber: 5,
        repoId: 'repo-1' as RepositoryId,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T19:00:00Z'),
      });
      const runAbort: RunAbortPort = {
        register: () => {},
        abort: () => {
          callOrder.push('abort');
          return Promise.resolve({ status: 'exited' });
        },
        unregister: () => {},
      };
      const git: GitPort = {
        createWorktree: async () => {},
        removeWorktree: async () => {},
        currentBranch: async () => '',
        headCommitSha: async () => 'sha-123',
        resetHard: async () => {
          throw new Error('reset fail');
        },
        diff: async () => '',
        commit: async () => '',
        push: async () => {},
        remoteRef: async () => undefined,
        isAncestor: async () => false,
        logBetween: async () => [],
        cleanUntracked: async () => {},
        headCommitShaOf: async () => 'sha-123',
      };
      const leases: WorkerLeasePort = {
        acquire: () => {
          throw new Error('unexpected');
        },
        heartbeat: () => {},
        release: () => {
          callOrder.push('release');
        },
        current: () => undefined,
        reclaimExpired: () => [],
      };
      const usecase = makeCancelRun({
        runRepository: repo,
        runAbort,
        git,
        leases,
        findCwd: () => '/tmp',
        findStartCommitSha: () => 'sha',
      });
      const res = await usecase.execute({ runId: runId('reset-throws') });
      expect(repo.updates).toHaveLength(1);
      expect(repo.updates[0]!.patch.status).toBe('cancelled');
      expect(callOrder).toContain('abort');
      expect(res.worktreeReset).toBe(false);
    });

    it('marks cancelled when lease release throws but other steps proceed', async () => {
      const callOrder: string[] = [];
      const repo = new FakeRunRepository();
      repo.addRun({
        uuid: 'lease-throws',
        displayId: 'issue-6-20260513-000000',
        issueNumber: 6,
        repoId: 'repo-1' as RepositoryId,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T19:00:00Z'),
      });
      const runAbort: RunAbortPort = {
        register: () => {},
        abort: () => {
          callOrder.push('abort');
          return Promise.resolve({ status: 'exited' });
        },
        unregister: () => {},
      };
      const git: GitPort = {
        createWorktree: async () => {},
        removeWorktree: async () => {},
        currentBranch: async () => '',
        headCommitSha: async () => 'sha-123',
        headCommitShaOf: async () => 'sha-123',
        resetHard: async () => {
          callOrder.push('reset');
        },
        diff: async () => '',
        commit: async () => '',
        push: async () => {},
        remoteRef: async () => undefined,
        isAncestor: async () => false,
        logBetween: async () => [],
        cleanUntracked: async () => {},
      };
      const leases: WorkerLeasePort = {
        acquire: () => {
          throw new Error('unexpected');
        },
        heartbeat: () => {},
        release: () => {},
        current: () => {
          throw new Error('lease fail');
        },
        reclaimExpired: () => [],
      };
      const usecase = makeCancelRun({
        runRepository: repo,
        runAbort,
        git,
        leases,
        findCwd: () => '/tmp',
        findStartCommitSha: () => 'sha',
      });
      await usecase.execute({ runId: runId('lease-throws') });
      expect(repo.updates).toHaveLength(1);
      expect(repo.updates[0]!.patch.status).toBe('cancelled');
      expect(callOrder).toEqual(['abort', 'reset']);
    });

    it('resets worktree even when findRepoId returns undefined', async () => {
      const callOrder: string[] = [];
      const repo = new FakeRunRepository();
      repo.addRun({
        uuid: 'no-repo',
        displayId: 'issue-10-20260513-000000',
        issueNumber: 10,
        repoId: undefined as unknown as RepositoryId,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T19:00:00Z'),
      });
      const git: GitPort = {
        createWorktree: async () => {},
        removeWorktree: async () => {},
        currentBranch: async () => '',
        headCommitSha: async () => 'sha-123',
        headCommitShaOf: async () => 'sha-123',
        resetHard: async () => {
          callOrder.push('reset');
        },
        diff: async () => '',
        commit: async () => '',
        push: async () => {},
        remoteRef: async () => undefined,
        isAncestor: async () => false,
        logBetween: async () => [],
        cleanUntracked: async () => {
          callOrder.push('clean');
        },
      };
      const leases: WorkerLeasePort = {
        acquire: () => {
          throw new Error('unexpected');
        },
        heartbeat: () => {},
        release: () => {
          callOrder.push('release');
        },
        current: () => {
          throw new Error('should not be called');
        },
        reclaimExpired: () => [],
      };
      const usecase = makeCancelRun({
        runRepository: repo,
        runAbort: noopAbort,
        git,
        leases,
        findCwd: () => '/tmp',
        findStartCommitSha: () => 'sha',
        logger: noopLogger,
        now: fixedNow,
      });
      await usecase.execute({ runId: runId('no-repo') });
      expect(repo.updates).toHaveLength(1);
      expect(repo.updates[0]!.patch.status).toBe('cancelled');
      expect(callOrder).toContain('reset');
      expect(callOrder).toContain('clean');
      expect(callOrder).not.toContain('release');
    });
  });
});
