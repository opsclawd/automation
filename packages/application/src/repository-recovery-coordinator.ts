import { WorkerId } from '@ai-sdlc/domain';
import type { RepositoryId, RunId, Run, Job, WorkerStatus } from '@ai-sdlc/domain';
import type { WorkerLeasePort, JobQueuePort, WorkerRegistryPort, RepositoryPort } from './ports.js';
import type { WorkerLease } from '@ai-sdlc/domain';

export type RepositoryRecoveryAction =
  | { action: 'leave' }
  | { action: 'reclaim' }
  | { action: 'requeue' }
  | { action: 'orphan-enqueue' }
  | { action: 'waiting-reactivate' };

export interface RepositoryRecoveryCoordinatorDeps {
  leases: WorkerLeasePort;
  queue: JobQueuePort;
  registry: WorkerRegistryPort;
  repos: RepositoryPort;
  findRun(runId: RunId): Run | undefined;
  isWorkerAlive(workerId: WorkerId): boolean;
  resetWorktree(repoId: RepositoryId): void;
  prepareWorktree?(input: {
    repoId: RepositoryId;
    runId: RunId;
    worktreePath: string;
    baseRef: string;
    quarantineRoot: string;
  }): Promise<{ safe: boolean; action: string; path: string }>;
  onOrphan(info: {
    repoId: RepositoryId;
    runId: RunId;
    previousWorkerId: WorkerId;
    reason: string;
  }): void;
  onWaitingReactivation(info: { repoId: RepositoryId; runId: RunId }): void;
  now(): Date;
  listRunsForRepo?(repoId: RepositoryId): Run[];
}

interface RepoState {
  lease: WorkerLease | undefined;
  jobs: Job[];
  activeNonExpiredJobs: Job[];
  activeExpiredClaimJobs: Job[];
  run: Run | undefined;
  workerStatus: WorkerStatus | undefined;
  repoEnabled: boolean;
  isLeaseExpired: boolean;
  isWorkerStale: boolean;
  hasActiveLease: boolean;
}

export class RepositoryRecoveryCoordinator {
  constructor(private readonly deps: RepositoryRecoveryCoordinatorDeps) {}

  execute(input: { repoId: RepositoryId }): RepositoryRecoveryAction {
    const { repoId } = input;
    const now = this.deps.now();

    const repo = this.deps.repos.findById(repoId);
    const repoEnabled = repo?.enabled ?? false;

    const lease = this.deps.leases.current(repoId);
    const jobs = this.deps.queue.listForRepo(repoId);
    const nowMs = now.getTime();

    const activeNonExpiredJobs = jobs.filter(
      (j) =>
        (j.status === 'queued' || j.status === 'claimed' || j.status === 'running') &&
        !(j.status === 'claimed' && j.claimExpiresAt && j.claimExpiresAt.getTime() < nowMs),
    );

    const activeExpiredClaimJobs = jobs.filter(
      (j) => j.status === 'claimed' && j.claimExpiresAt && j.claimExpiresAt.getTime() < nowMs,
    );

    let run: Run | undefined;
    if (lease) {
      run = this.deps.findRun(lease.runId);
    } else {
      const activeJob = activeNonExpiredJobs[0] || activeExpiredClaimJobs[0];
      if (activeJob) {
        run = this.deps.findRun(activeJob.runId);
      }
    }

    let workerStatus: WorkerStatus | undefined;
    let isWorkerStale = false;
    if (lease) {
      const workerAlive = this.deps.isWorkerAlive(lease.workerId);
      const worker = this.deps.registry.findById(lease.workerId, repoId);
      workerStatus = worker?.status;
      isWorkerStale = !workerAlive || workerStatus === 'stopping' || workerStatus === 'unhealthy';
    }

    const isLeaseExpired = lease ? lease.expiresAt.getTime() <= now.getTime() : false;
    const hasActiveLease = this.deps.leases.checkActiveLease(repoId, now);

    const state: RepoState = {
      lease,
      jobs,
      activeNonExpiredJobs,
      activeExpiredClaimJobs,
      run,
      workerStatus,
      repoEnabled,
      isLeaseExpired,
      isWorkerStale,
      hasActiveLease,
    };

    return this.determineAction(repoId, state);
  }

  private determineAction(repoId: RepositoryId, state: RepoState): RepositoryRecoveryAction {
    if (state.hasActiveLease) {
      return { action: 'leave' };
    }

    if (state.activeNonExpiredJobs.some((j) => j.status === 'queued')) {
      return { action: 'leave' };
    }

    if (state.activeExpiredClaimJobs.length > 0) {
      return { action: 'requeue' };
    }

    if (state.lease) {
      return this.determineLeaseAction(repoId, state);
    }

    if (state.run) {
      return this.determineNoLeaseWithRunAction(repoId, state);
    }

    if (state.activeNonExpiredJobs.length > 0) {
      return { action: 'leave' };
    }

    if (this.deps.listRunsForRepo) {
      const runs = this.deps.listRunsForRepo(repoId);
      const waitingRun = runs.find((r) => r.status === 'waiting');
      if (waitingRun) {
        if (!state.repoEnabled) {
          return { action: 'leave' };
        }
        this.deps.onWaitingReactivation({ repoId, runId: waitingRun.uuid as RunId });
        return { action: 'waiting-reactivate' };
      }
    }

    return { action: 'leave' };
  }

  private determineLeaseAction(repoId: RepositoryId, state: RepoState): RepositoryRecoveryAction {
    const hasStaleLeaseWithRecoverableRun =
      state.isLeaseExpired && state.isWorkerStale && state.run && this.isRecoverable(state.run);

    if (state.activeNonExpiredJobs.length > 0) {
      if (hasStaleLeaseWithRecoverableRun) {
        this.deps.resetWorktree(repoId);
        return { action: 'reclaim' };
      }
      return { action: 'leave' };
    }

    if (hasStaleLeaseWithRecoverableRun) {
      if (!state.repoEnabled) {
        this.deps.resetWorktree(repoId);
        return { action: 'reclaim' };
      }
      this.deps.onOrphan({
        repoId,
        runId: state.run!.uuid as RunId,
        previousWorkerId: state.lease!.workerId,
        reason: 'stale lease with no active jobs',
      });
      return { action: 'orphan-enqueue' };
    }

    return { action: 'leave' };
  }

  private determineNoLeaseWithRunAction(
    repoId: RepositoryId,
    state: RepoState,
  ): RepositoryRecoveryAction {
    if (state.run!.status === 'waiting') {
      if (!state.repoEnabled) {
        return { action: 'leave' };
      }
      this.deps.onWaitingReactivation({ repoId, runId: state.run!.uuid as RunId });
      return { action: 'waiting-reactivate' };
    }

    if (state.run!.status === 'running') {
      this.deps.onOrphan({
        repoId,
        runId: state.run!.uuid as RunId,
        previousWorkerId: state.lease?.workerId ?? WorkerId('unknown'),
        reason: 'no active lease',
      });
      return { action: 'orphan-enqueue' };
    }

    return { action: 'leave' };
  }

  private isRecoverable(run: Run | undefined): boolean {
    if (!run) return false;
    return run.status === 'running' || run.status === 'waiting';
  }
}
