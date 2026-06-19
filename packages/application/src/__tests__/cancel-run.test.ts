import { describe, expect, it } from 'vitest';
import type { Run, RunStatus, RunId, RepositoryId, WorkerLease } from '@ai-sdlc/domain';
import { CancelRun } from '../cancel-run.js';
import type {
  RunRecord,
  RunRepositoryPort,
  RunRepositoryUpdatePatch,
  GitPort,
  WorkerLeasePort,
  RunAbortPort,
} from '../ports.js';

interface RecordedUpdate {
  uuid: string;
  patch: RunRepositoryUpdatePatch;
}

class FakeRunRepo implements RunRepositoryPort {
  runs: Map<string, RunRecord> = new Map();
  updates: RecordedUpdate[] = [];
  insertIfNoActive(_run: Run): void {}
  update(uuid: string, patch: RunRepositoryUpdatePatch): void {
    this.updates.push({ uuid, patch });
  }
  findByUuid(uuid: string): RunRecord | undefined {
    return this.runs.get(uuid);
  }
  findByIssueNumber(issueNumber: number): RunRecord | undefined {
    let latest: RunRecord | undefined;
    for (const r of this.runs.values()) {
      if (r.issueNumber === issueNumber) {
        if (!latest || r.startedAt > latest.startedAt) latest = r;
      }
    }
    return latest;
  }
  findActiveRuns(): RunRecord[] {
    return Array.from(this.runs.values()).filter(
      (r) => !['passed', 'failed', 'cancelled'].includes(r.status),
    );
  }
  updateStatusByIssueNumber(
    issueNumber: number,
    patch: { status: RunStatus; completedAt: Date; failureReason?: string },
  ): boolean {
    for (const [uuid, r] of this.runs) {
      if (r.issueNumber === issueNumber && !['passed', 'failed', 'cancelled'].includes(r.status)) {
        r.status = patch.status;
        r.completedAt = patch.completedAt;
        r.failureReason = patch.failureReason;
        this.updates.push({
          uuid,
          patch: {
            status: patch.status,
            completedAt: patch.completedAt,
            ...(patch.failureReason ? { failureReason: patch.failureReason } : {}),
          },
        });
        return true;
      }
    }
    return false;
  }
  updateStatusByUuid(
    uuid: string,
    patch: { status: RunStatus; completedAt: Date; failureReason?: string },
  ): boolean {
    const r = this.runs.get(uuid);
    if (!r || ['passed', 'failed', 'cancelled'].includes(r.status)) return false;
    r.status = patch.status;
    r.completedAt = patch.completedAt;
    r.failureReason = patch.failureReason;
    this.updates.push({
      uuid,
      patch: {
        status: patch.status,
        completedAt: patch.completedAt,
        ...(patch.failureReason ? { failureReason: patch.failureReason } : {}),
      },
    });
    return true;
  }
  addRun(r: RunRecord): void {
    this.runs.set(r.uuid, r);
  }
}

const fixedNow = () => new Date('2026-05-13T19:23:00Z');
const runId = (s: string) => s as RunId;

const noopAbort: RunAbortPort = { register: () => {}, abort: () => {}, unregister: () => {} };
const noopGit = { resetHard: () => Promise.resolve() } as GitPort;
const noopLeases: WorkerLeasePort = {
  acquire: () => {
    throw new Error('unexpected');
  },
  heartbeat: () => {},
  release: () => {},
  current: () => undefined,
  reclaimExpired: () => [],
};
const noopFindCwd = () => '/tmp/worktree';
const noopFindStartSha = () => 'abc123';
const noopFindRepoId = () => 'repo-1' as RepositoryId;

function makeCancelRun(deps: Partial<Parameters<typeof CancelRun.prototype.constructor>[0]> = {}) {
  return new CancelRun({
    runRepository: deps.runRepository ?? new FakeRunRepo(),
    runAbort: deps.runAbort ?? noopAbort,
    git: deps.git ?? noopGit,
    leases: deps.leases ?? noopLeases,
    findCwd: deps.findCwd ?? noopFindCwd,
    findStartCommitSha: deps.findStartCommitSha ?? noopFindStartSha,
    findRepoId: deps.findRepoId ?? noopFindRepoId,
    now: deps.now ?? fixedNow,
  });
}

describe('CancelRun', () => {
  it('cancels an active run by runId', async () => {
    const repo = new FakeRunRepo();
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
    await usecase.execute({ runId: runId('abc-123'), reason: 'user requested' });
    expect(repo.updates).toHaveLength(1);
    expect(repo.updates[0]!.patch.status).toBe('cancelled');
    expect(repo.updates[0]!.patch.failureReason).toBe('user requested');
    expect(repo.updates[0]!.patch.completedAt).toEqual(fixedNow());
  });

  it('throws when no run exists for the given runId', async () => {
    const repo = new FakeRunRepo();
    const usecase = makeCancelRun({ runRepository: repo });
    await expect(usecase.execute({ runId: runId('nonexistent') })).rejects.toThrow(/no run found/i);
  });

  it('throws when the run is already terminal', async () => {
    const repo = new FakeRunRepo();
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
    const repo = new FakeRunRepo();
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
    await usecase.execute({ runId: runId('abc-789') });
    expect(repo.updates[0]!.patch.failureReason).toBeUndefined();
  });

  it('marks the run as cancelled via updateStatusByUuid', async () => {
    const repo = new FakeRunRepo();
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

  it('throws when updateStatusByUuid returns false (concurrent cancellation)', async () => {
    const repo = new FakeRunRepo();
    repo.addRun({
      uuid: 'concurrent-cancel',
      displayId: 'issue-8-20260513-000000',
      issueNumber: 8,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T19:00:00Z'),
    });
    repo.updateStatusByUuid = () => false;
    const usecase = makeCancelRun({ runRepository: repo });
    await expect(usecase.execute({ runId: runId('concurrent-cancel') })).rejects.toThrow(
      /already running/i,
    );
  });

  describe('ordering', () => {
    it('calls runAbort.abort() before git.resetHard()', async () => {
      const callOrder: string[] = [];
      const runAbort: RunAbortPort = {
        register: () => {},
        abort: () => {
          callOrder.push('abort');
        },
        unregister: () => {},
      };
      const git: GitPort = {
        createWorktree: async () => {},
        removeWorktree: async () => {},
        currentBranch: async () => '',
        headCommitSha: async () => '',
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
        headCommitShaOf: async () => undefined,
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
      const repo = new FakeRunRepo();
      repo.addRun({
        uuid: 'order-1',
        displayId: 'issue-1-20260513-000000',
        issueNumber: 1,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T19:00:00Z'),
      });
      const usecase = new CancelRun({
        runRepository: repo,
        runAbort,
        git,
        leases,
        findCwd: () => '/tmp/worktree',
        findStartCommitSha: () => 'sha',
        findRepoId: () => 'repo-1' as RepositoryId,
        now: fixedNow,
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
        headCommitSha: async () => '',
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
        headCommitShaOf: async () => undefined,
      };
      const leaseObj: WorkerLease = {
        repoId: 'repo-1' as RepositoryId,
        workerId: 'w-1' as unknown as WorkerLease['workerId'],
        runId: 'order-2' as unknown as WorkerLease['runId'],
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(),
      };
      const repo = new FakeRunRepo();
      repo.addRun({
        uuid: 'order-2',
        displayId: 'issue-2-20260513-000000',
        issueNumber: 2,
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
      const usecase = new CancelRun({
        runRepository: repo,
        runAbort: noopAbort,
        git,
        leases,
        findCwd: () => '/tmp/worktree',
        findStartCommitSha: () => 'sha',
        findRepoId: () => 'repo-1' as RepositoryId,
        now: fixedNow,
      });
      await usecase.execute({ runId: runId('order-2') });
      const resetIdx = callOrder.indexOf('reset');
      const releaseIdx = callOrder.indexOf('release');
      expect(resetIdx).toBeLessThan(releaseIdx);
    });

    it('marks cancelled even when all best-effort steps throw', async () => {
      const repo = new FakeRunRepo();
      repo.addRun({
        uuid: 'best-effort',
        displayId: 'issue-3-20260513-000000',
        issueNumber: 3,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T19:00:00Z'),
      });
      const runAbort: RunAbortPort = {
        register: () => {},
        abort: () => {
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
        headCommitSha: async () => '',
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
        headCommitShaOf: async () => undefined,
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
      const usecase = new CancelRun({
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
        findRepoId: () => {
          throw new Error('repoId fail');
        },
        now: fixedNow,
      });
      await usecase.execute({ runId: runId('best-effort') });
      expect(repo.updates).toHaveLength(1);
      expect(repo.updates[0]!.patch.status).toBe('cancelled');
    });

    it('marks cancelled when abort throws but other steps proceed', async () => {
      const callOrder: string[] = [];
      const repo = new FakeRunRepo();
      repo.addRun({
        uuid: 'abort-throws',
        displayId: 'issue-4-20260513-000000',
        issueNumber: 4,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T19:00:00Z'),
      });
      const runAbort: RunAbortPort = {
        register: () => {},
        abort: () => {
          throw new Error('abort fail');
        },
        unregister: () => {},
      };
      const git: GitPort = {
        createWorktree: async () => {},
        removeWorktree: async () => {},
        currentBranch: async () => '',
        headCommitSha: async () => '',
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
        headCommitShaOf: async () => undefined,
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
      const usecase = new CancelRun({
        runRepository: repo,
        runAbort,
        git,
        leases,
        findCwd: () => '/tmp/worktree',
        findStartCommitSha: () => 'sha',
        findRepoId: () => 'repo-1' as RepositoryId,
        now: fixedNow,
      });
      await usecase.execute({ runId: runId('abort-throws') });
      expect(repo.updates).toHaveLength(1);
      expect(repo.updates[0]!.patch.status).toBe('cancelled');
      expect(callOrder).toContain('reset');
    });

    it('marks cancelled when resetHard throws but other steps proceed', async () => {
      const callOrder: string[] = [];
      const repo = new FakeRunRepo();
      repo.addRun({
        uuid: 'reset-throws',
        displayId: 'issue-5-20260513-000000',
        issueNumber: 5,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T19:00:00Z'),
      });
      const runAbort: RunAbortPort = {
        register: () => {},
        abort: () => {
          callOrder.push('abort');
        },
        unregister: () => {},
      };
      const git: GitPort = {
        createWorktree: async () => {},
        removeWorktree: async () => {},
        currentBranch: async () => '',
        headCommitSha: async () => '',
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
        headCommitShaOf: async () => undefined,
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
      const usecase = new CancelRun({
        runRepository: repo,
        runAbort,
        git,
        leases,
        findCwd: () => '/tmp/worktree',
        findStartCommitSha: () => 'sha',
        findRepoId: () => 'repo-1' as RepositoryId,
        now: fixedNow,
      });
      await usecase.execute({ runId: runId('reset-throws') });
      expect(repo.updates).toHaveLength(1);
      expect(repo.updates[0]!.patch.status).toBe('cancelled');
      expect(callOrder).toContain('abort');
    });

    it('marks cancelled when lease release throws but other steps proceed', async () => {
      const callOrder: string[] = [];
      const repo = new FakeRunRepo();
      repo.addRun({
        uuid: 'lease-throws',
        displayId: 'issue-6-20260513-000000',
        issueNumber: 6,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T19:00:00Z'),
      });
      const runAbort: RunAbortPort = {
        register: () => {},
        abort: () => {
          callOrder.push('abort');
        },
        unregister: () => {},
      };
      const git: GitPort = {
        createWorktree: async () => {},
        removeWorktree: async () => {},
        currentBranch: async () => '',
        headCommitSha: async () => '',
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
        headCommitShaOf: async () => undefined,
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
      const usecase = new CancelRun({
        runRepository: repo,
        runAbort,
        git,
        leases,
        findCwd: () => '/tmp/worktree',
        findStartCommitSha: () => 'sha',
        findRepoId: () => 'repo-1' as RepositoryId,
        now: fixedNow,
      });
      await usecase.execute({ runId: runId('lease-throws') });
      expect(repo.updates).toHaveLength(1);
      expect(repo.updates[0]!.patch.status).toBe('cancelled');
      expect(callOrder).toEqual(['abort', 'reset']);
    });
  });
});
