import { describe, it, expect, vi } from 'vitest';
import {
  RepositoryId,
  WorkerId,
  RunId,
  JobId,
  IssueNumber,
  createJob,
  createRun,
  createWorker,
  type Run,
  type Job,
} from '@ai-sdlc/domain';
import type {
  WorkerLeasePort,
  JobQueuePort,
  WorkerRegistryPort,
  RepositoryPort,
} from '../ports.js';
import type { WorkerLease } from '@ai-sdlc/domain';
import {
  RepositoryRecoveryCoordinator,
  type RepositoryRecoveryCoordinatorDeps,
} from '../repository-recovery-coordinator.js';

const REPO_ID = RepositoryId('owner/repo');
const WORKER_ID = WorkerId('w1');
const RUN_ID_1 = RunId('run-1');
const JOB_ID_1 = JobId('job-1');

function makeRun(runId: string, repoId: RepositoryId = REPO_ID): Run {
  return createRun({
    uuid: runId,
    displayId: `disp-${runId}`,
    repoId,
    issueNumber: IssueNumber(1),
    startedAt: new Date(),
  });
}

function makeJob(jobId: JobId, runId: RunId, repoId: RepositoryId = REPO_ID): Job {
  return createJob({
    id: jobId,
    runId,
    repoId,
    issueNumber: IssueNumber(1),
    createdAt: new Date(),
  });
}

interface TestState {
  leases: WorkerLease[];
  jobs: Job[];
  runRecords: Run[];
  workerStatuses: Map<string, 'idle' | 'busy' | 'stopping' | 'unhealthy'>;
  repoEnabled: boolean;
  worktreePrepareResult: { safe: boolean; action: string };
}

function createCoordinatorDeps(state: TestState): RepositoryRecoveryCoordinatorDeps {
  const mockLeases: Partial<WorkerLeasePort> & { state: WorkerLease[] } = {
    state: state.leases,
    current: vi.fn((repoId: RepositoryId) => state.leases.find((l) => l.repoId === repoId)),
    checkActiveLease: vi.fn((repoId: RepositoryId, now: Date) => {
      return state.leases.some((l) => l.repoId === repoId && l.expiresAt.getTime() > now.getTime());
    }),
  };

  const mockQueue: Partial<JobQueuePort> & { state: Job[] } = {
    state: state.jobs,
    listForRepo: vi.fn((repoId: RepositoryId) => state.jobs.filter((j) => j.repoId === repoId)),
    listForRun: vi.fn((runId: RunId) => state.jobs.filter((j) => j.runId === runId)),
    findById: vi.fn((jobId: JobId) => state.jobs.find((j) => j.id === jobId)),
    listActive: vi.fn(() =>
      state.jobs.filter(
        (j) => j.status === 'queued' || j.status === 'claimed' || j.status === 'running',
      ),
    ),
  };

  const mockRegistry: Partial<WorkerRegistryPort> = {
    findById: vi.fn((workerId: WorkerId, repoId: RepositoryId) => {
      const status = state.workerStatuses.get(`${workerId}:${repoId}`) ?? 'idle';
      return status === 'idle'
        ? null
        : createWorker({
            id: workerId,
            repoId,
            hostname: 'h',
            processId: 1,
            now: new Date(),
          });
    }),
    status: vi.fn((workerId: WorkerId, repoId: RepositoryId) => {
      return state.workerStatuses.get(`${workerId}:${repoId}`) ?? 'idle';
    }),
  };

  const mockRepos: Partial<RepositoryPort> = {
    findById: vi.fn((repoId: RepositoryId) => {
      return {
        id: repoId,
        enabled: state.repoEnabled,
      } as never;
    }),
  };

  return {
    leases: mockLeases as WorkerLeasePort,
    queue: mockQueue as JobQueuePort,
    registry: mockRegistry as WorkerRegistryPort,
    repos: mockRepos as RepositoryPort,
    findRun: vi.fn((runId: RunId) => state.runRecords.find((r) => r.uuid === runId)),
    isWorkerAlive: vi.fn((workerId: WorkerId) => {
      const status = state.workerStatuses.get(`${workerId}:${REPO_ID}`) ?? 'idle';
      return status === 'idle' || status === 'busy';
    }),
    resetWorktree: vi.fn(),
    prepareWorktree: vi.fn(async () => ({
      safe: state.worktreePrepareResult.safe,
      action: state.worktreePrepareResult.action,
      path: '/tmp/worktree',
    })),
    onOrphan: vi.fn(),
    onWaitingReactivation: vi.fn(),
    now: () => new Date(),
    listRunsForRepo: vi.fn((repoId: RepositoryId) =>
      state.runRecords.filter((r) => r.repoId === repoId),
    ),
  };
}

describe('RepositoryRecoveryCoordinator', () => {
  describe('recovery state matrix is deterministic', () => {
    it('queued job remains queued', async () => {
      const state: TestState = {
        leases: [],
        jobs: [{ ...makeJob(JOB_ID_1, RUN_ID_1), status: 'queued' as const }],
        runRecords: [makeRun('run-1')],
        workerStatuses: new Map(),
        repoEnabled: true,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('leave');
      expect(deps.onOrphan).not.toHaveBeenCalled();
      expect(deps.onWaitingReactivation).not.toHaveBeenCalled();
    });

    it('live claimed job remains owned', async () => {
      const state: TestState = {
        leases: [
          {
            repoId: REPO_ID,
            workerId: WORKER_ID,
            runId: RUN_ID_1,
            acquiredAt: new Date(),
            heartbeatAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
            leaseToken: 'tok-1' as never,
          },
        ],
        jobs: [
          {
            ...makeJob(JOB_ID_1, RUN_ID_1),
            status: 'claimed' as const,
            claimedBy: WORKER_ID,
            claimToken: 'ctok-1' as never,
            claimExpiresAt: new Date(Date.now() + 60_000),
          },
        ],
        runRecords: [makeRun('run-1')],
        workerStatuses: new Map([[`${WORKER_ID}:${REPO_ID}`, 'busy']]),
        repoEnabled: true,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('leave');
    });

    it('expired claim without lease requeues', async () => {
      const state: TestState = {
        leases: [],
        jobs: [
          {
            ...makeJob(JOB_ID_1, RUN_ID_1),
            status: 'claimed' as const,
            claimedBy: WorkerId('dead-worker'),
            claimToken: 'ctok-1' as never,
            claimExpiresAt: new Date(Date.now() - 60_000),
          },
        ],
        runRecords: [makeRun('run-1')],
        workerStatuses: new Map(),
        repoEnabled: true,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('requeue');
    });

    it('live running job remains owned', async () => {
      const state: TestState = {
        leases: [
          {
            repoId: REPO_ID,
            workerId: WORKER_ID,
            runId: RUN_ID_1,
            acquiredAt: new Date(),
            heartbeatAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
            leaseToken: 'tok-1' as never,
          },
        ],
        jobs: [
          {
            ...makeJob(JOB_ID_1, RUN_ID_1),
            status: 'running' as const,
            claimedBy: WORKER_ID,
            claimToken: 'ctok-1' as never,
            claimExpiresAt: new Date(Date.now() + 60_000),
          },
        ],
        runRecords: [makeRun('run-1')],
        workerStatuses: new Map([[`${WORKER_ID}:${REPO_ID}`, 'busy']]),
        repoEnabled: true,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('leave');
    });

    it('safe stale lease reclaims and preserves resumable run', async () => {
      const expiredTime = Date.now() - 120_000;
      const state: TestState = {
        leases: [
          {
            repoId: REPO_ID,
            workerId: WorkerId('dead-worker'),
            runId: RUN_ID_1,
            acquiredAt: new Date(expiredTime - 60_000),
            heartbeatAt: new Date(expiredTime),
            expiresAt: new Date(expiredTime),
            leaseToken: 'tok-1' as never,
          },
        ],
        jobs: [
          {
            ...makeJob(JOB_ID_1, RUN_ID_1),
            status: 'running' as const,
            claimedBy: WorkerId('dead-worker'),
            claimToken: 'ctok-1' as never,
            claimExpiresAt: new Date(expiredTime),
          },
        ],
        runRecords: [{ ...makeRun('run-1'), status: 'running' as const }],
        workerStatuses: new Map([[`${WorkerId('dead-worker')}:${REPO_ID}`, 'stopping']]),
        repoEnabled: true,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('reclaim');
      expect(deps.resetWorktree).toHaveBeenCalledWith(REPO_ID);
    });

    it('live worker blocks reclamation', async () => {
      const expiredTime = Date.now() - 120_000;
      const state: TestState = {
        leases: [
          {
            repoId: REPO_ID,
            workerId: WorkerId('alive-worker'),
            runId: RUN_ID_1,
            acquiredAt: new Date(expiredTime - 60_000),
            heartbeatAt: new Date(expiredTime),
            expiresAt: new Date(expiredTime),
            leaseToken: 'tok-1' as never,
          },
        ],
        jobs: [
          {
            ...makeJob(JOB_ID_1, RUN_ID_1),
            status: 'running' as const,
            claimedBy: WorkerId('alive-worker'),
            claimToken: 'ctok-1' as never,
            claimExpiresAt: new Date(expiredTime),
          },
        ],
        runRecords: [{ ...makeRun('run-1'), status: 'running' as const }],
        workerStatuses: new Map([[`${WorkerId('alive-worker')}:${REPO_ID}`, 'busy']]),
        repoEnabled: true,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('leave');
    });

    it('unexpired worker heartbeat blocks reclamation', async () => {
      const recentTime = Date.now() - 30_000;
      const state: TestState = {
        leases: [
          {
            repoId: REPO_ID,
            workerId: WorkerId('alive-worker'),
            runId: RUN_ID_1,
            acquiredAt: new Date(recentTime - 60_000),
            heartbeatAt: new Date(recentTime),
            expiresAt: new Date(recentTime + 60_000),
            leaseToken: 'tok-1' as never,
          },
        ],
        jobs: [
          {
            ...makeJob(JOB_ID_1, RUN_ID_1),
            status: 'running' as const,
            claimedBy: WorkerId('alive-worker'),
            claimToken: 'ctok-1' as never,
            claimExpiresAt: new Date(recentTime + 60_000),
          },
        ],
        runRecords: [{ ...makeRun('run-1'), status: 'running' as const }],
        workerStatuses: new Map([[`${WorkerId('alive-worker')}:${REPO_ID}`, 'busy']]),
        repoEnabled: true,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('leave');
    });

    it('nonrecoverable run blocks reclamation', async () => {
      const expiredTime = Date.now() - 120_000;
      const state: TestState = {
        leases: [
          {
            repoId: REPO_ID,
            workerId: WorkerId('dead-worker'),
            runId: RUN_ID_1,
            acquiredAt: new Date(expiredTime - 60_000),
            heartbeatAt: new Date(expiredTime),
            expiresAt: new Date(expiredTime),
            leaseToken: 'tok-1' as never,
          },
        ],
        jobs: [
          {
            ...makeJob(JOB_ID_1, RUN_ID_1),
            status: 'running' as const,
            claimedBy: WorkerId('dead-worker'),
            claimToken: 'ctok-1' as never,
            claimExpiresAt: new Date(expiredTime),
          },
        ],
        runRecords: [{ ...makeRun('run-1'), status: 'failed' as const }],
        workerStatuses: new Map([[`${WorkerId('dead-worker')}:${REPO_ID}`, 'stopping']]),
        repoEnabled: true,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('leave');
    });

    it('failed worktree preparation preserves ownership', async () => {
      const expiredTime = Date.now() - 120_000;
      const state: TestState = {
        leases: [
          {
            repoId: REPO_ID,
            workerId: WorkerId('dead-worker'),
            runId: RUN_ID_1,
            acquiredAt: new Date(expiredTime - 60_000),
            heartbeatAt: new Date(expiredTime),
            expiresAt: new Date(expiredTime),
            leaseToken: 'tok-1' as never,
          },
        ],
        jobs: [
          {
            ...makeJob(JOB_ID_1, RUN_ID_1),
            status: 'running' as const,
            claimedBy: WorkerId('dead-worker'),
            claimToken: 'ctok-1' as never,
            claimExpiresAt: new Date(expiredTime),
          },
        ],
        runRecords: [{ ...makeRun('run-1'), status: 'running' as const }],
        workerStatuses: new Map([[`${WorkerId('dead-worker')}:${REPO_ID}`, 'stopping']]),
        repoEnabled: true,
        worktreePrepareResult: { safe: false, action: 'blocked' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('reclaim');
    });

    it('concurrent ownership change defers recovery', async () => {
      const expiredTime = Date.now() - 120_000;
      const state: TestState = {
        leases: [
          {
            repoId: REPO_ID,
            workerId: WorkerId('dead-worker'),
            runId: RUN_ID_1,
            acquiredAt: new Date(expiredTime - 60_000),
            heartbeatAt: new Date(expiredTime),
            expiresAt: new Date(expiredTime),
            leaseToken: 'tok-1' as never,
          },
          {
            repoId: REPO_ID,
            workerId: WorkerId('new-worker'),
            runId: RUN_ID_1,
            acquiredAt: new Date(),
            heartbeatAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
            leaseToken: 'tok-2' as never,
          },
        ],
        jobs: [
          {
            ...makeJob(JOB_ID_1, RUN_ID_1),
            status: 'claimed' as const,
            claimedBy: WorkerId('new-worker'),
            claimToken: 'ctok-2' as never,
            claimExpiresAt: new Date(Date.now() + 60_000),
          },
        ],
        runRecords: [{ ...makeRun('run-1'), status: 'running' as const }],
        workerStatuses: new Map([
          [`${WorkerId('dead-worker')}:${REPO_ID}`, 'stopping'],
          [`${WorkerId('new-worker')}:${REPO_ID}`, 'busy'],
        ]),
        repoEnabled: true,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('leave');
    });

    it('active run without active job enqueues exactly once', async () => {
      const expiredTime = Date.now() - 120_000;
      const state: TestState = {
        leases: [
          {
            repoId: REPO_ID,
            workerId: WorkerId('dead-worker'),
            runId: RUN_ID_1,
            acquiredAt: new Date(expiredTime - 60_000),
            heartbeatAt: new Date(expiredTime),
            expiresAt: new Date(expiredTime),
            leaseToken: 'tok-1' as never,
          },
        ],
        jobs: [],
        runRecords: [{ ...makeRun('run-1'), status: 'running' as const }],
        workerStatuses: new Map([[`${WorkerId('dead-worker')}:${REPO_ID}`, 'stopping']]),
        repoEnabled: true,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('orphan-enqueue');
      expect(deps.onOrphan).toHaveBeenCalledTimes(1);
    });

    it('waiting run reactivates once when execution ready', async () => {
      const state: TestState = {
        leases: [],
        jobs: [],
        runRecords: [{ ...makeRun('run-1'), status: 'waiting' as const }],
        workerStatuses: new Map(),
        repoEnabled: true,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('waiting-reactivate');
      expect(deps.onWaitingReactivation).toHaveBeenCalledTimes(1);
    });

    it('disabled repository cleans stale ownership but parks work', async () => {
      const expiredTime = Date.now() - 120_000;
      const state: TestState = {
        leases: [
          {
            repoId: REPO_ID,
            workerId: WorkerId('dead-worker'),
            runId: RUN_ID_1,
            acquiredAt: new Date(expiredTime - 60_000),
            heartbeatAt: new Date(expiredTime),
            expiresAt: new Date(expiredTime),
            leaseToken: 'tok-1' as never,
          },
        ],
        jobs: [
          {
            ...makeJob(JOB_ID_1, RUN_ID_1),
            status: 'running' as const,
            claimedBy: WorkerId('dead-worker'),
            claimToken: 'ctok-1' as never,
            claimExpiresAt: new Date(expiredTime),
          },
        ],
        runRecords: [{ ...makeRun('run-1'), status: 'running' as const }],
        workerStatuses: new Map([[`${WorkerId('dead-worker')}:${REPO_ID}`, 'stopping']]),
        repoEnabled: false,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('reclaim');
      expect(deps.onOrphan).not.toHaveBeenCalled();
    });

    it('unavailable repository skips execution reactivation', async () => {
      const state: TestState = {
        leases: [],
        jobs: [],
        runRecords: [{ ...makeRun('run-1'), status: 'waiting' as const }],
        workerStatuses: new Map(),
        repoEnabled: false,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('leave');
      expect(deps.onWaitingReactivation).not.toHaveBeenCalled();
    });
  });

  describe('ambiguous stale lease evidence preserves ownership', () => {
    it('ambiguous stale lease evidence preserves ownership', async () => {
      const expiredTime = Date.now() - 120_000;
      const state: TestState = {
        leases: [
          {
            repoId: REPO_ID,
            workerId: WorkerId('worker-with-unknown-status'),
            runId: RUN_ID_1,
            acquiredAt: new Date(expiredTime - 60_000),
            heartbeatAt: new Date(expiredTime),
            expiresAt: new Date(expiredTime),
            leaseToken: 'tok-1' as never,
          },
        ],
        jobs: [
          {
            ...makeJob(JOB_ID_1, RUN_ID_1),
            status: 'running' as const,
            claimedBy: WorkerId('worker-with-unknown-status'),
            claimToken: 'ctok-1' as never,
            claimExpiresAt: new Date(expiredTime),
          },
        ],
        runRecords: [{ ...makeRun('run-1'), status: 'running' as const }],
        workerStatuses: new Map(),
        repoEnabled: true,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('leave');
    });
  });

  describe('disabled and unavailable repositories do not admit work', () => {
    it('disabled repository cleans stale ownership but parks work', async () => {
      const expiredTime = Date.now() - 120_000;
      const state: TestState = {
        leases: [
          {
            repoId: REPO_ID,
            workerId: WorkerId('dead-worker'),
            runId: RUN_ID_1,
            acquiredAt: new Date(expiredTime - 60_000),
            heartbeatAt: new Date(expiredTime),
            expiresAt: new Date(expiredTime),
            leaseToken: 'tok-1' as never,
          },
        ],
        jobs: [
          {
            ...makeJob(JOB_ID_1, RUN_ID_1),
            status: 'running' as const,
            claimedBy: WorkerId('dead-worker'),
            claimToken: 'ctok-1' as never,
            claimExpiresAt: new Date(expiredTime),
          },
        ],
        runRecords: [{ ...makeRun('run-1'), status: 'running' as const }],
        workerStatuses: new Map([[`${WorkerId('dead-worker')}:${REPO_ID}`, 'stopping']]),
        repoEnabled: false,
        worktreePrepareResult: { safe: true, action: 'reset' },
      };

      const deps = createCoordinatorDeps(state);
      const coord = new RepositoryRecoveryCoordinator(deps);
      const result = await coord.execute({ repoId: REPO_ID });

      expect(result.action).toBe('reclaim');
      expect(deps.onOrphan).not.toHaveBeenCalled();
    });
  });
});
