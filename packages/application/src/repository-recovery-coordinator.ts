import { WorkerId } from '@ai-sdlc/domain';
import type { RepositoryId, RunId, Run, Job, WorkerStatus } from '@ai-sdlc/domain';
import type { WorkerLeasePort, JobQueuePort, WorkerRegistryPort, RepositoryPort } from './ports.js';
import type { WorkerLease } from '@ai-sdlc/domain';
import type { OperationalRecoveryPort } from './ports/operational-recovery-port.js';
import type { WorktreeRecoveryPort } from './ports/worktree-recovery-port.js';

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
  registryWorkerHostname?(workerId: WorkerId, repoId: RepositoryId): string | undefined;
  checkPid?(pid: number): boolean;
  isWorkerAlive(workerId: WorkerId): boolean;
  resetWorktree(repoId: RepositoryId): void;
  worktreeRecovery?: WorktreeRecoveryPort;
  operationalRecovery?: OperationalRecoveryPort;
  getWorktreePath?(repoId: RepositoryId): string;
  getQuarantineRoot?(repoId: RepositoryId): string;
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
  workerHostname: string | undefined;
  repoEnabled: boolean;
  isLeaseExpired: boolean;
  isWorkerStale: boolean;
  hasActiveLease: boolean;
  isSameHost: boolean;
}

export class RepositoryRecoveryCoordinator {
  constructor(private readonly deps: RepositoryRecoveryCoordinatorDeps) {}

  async execute(input: { repoId: RepositoryId }): Promise<RepositoryRecoveryAction> {
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
    let workerHostname: string | undefined;
    let isWorkerStale = false;
    let isSameHost = false;
    if (lease) {
      const worker = this.deps.registry.findById(lease.workerId, repoId);
      workerStatus = worker?.status;
      workerHostname = worker?.hostname;
      const workerAlive = this.deps.isWorkerAlive(lease.workerId);
      isSameHost =
        workerHostname !== undefined &&
        this.deps.registryWorkerHostname !== undefined &&
        workerHostname === this.deps.registryWorkerHostname(lease.workerId, repoId);
      const isPidDead =
        isSameHost && this.deps.checkPid && worker ? !this.deps.checkPid(worker.processId) : false;
      isWorkerStale =
        !workerAlive || workerStatus === 'stopping' || workerStatus === 'unhealthy' || isPidDead;
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
      workerHostname,
      repoEnabled,
      isLeaseExpired,
      isWorkerStale,
      hasActiveLease,
      isSameHost,
    };

    return this.determineAction(repoId, state);
  }

  private async determineAction(
    repoId: RepositoryId,
    state: RepoState,
  ): Promise<RepositoryRecoveryAction> {
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

  private async determineLeaseAction(
    repoId: RepositoryId,
    state: RepoState,
  ): Promise<RepositoryRecoveryAction> {
    const hasStaleLeaseWithRecoverableRun =
      state.isLeaseExpired && state.isWorkerStale && state.run && this.isRecoverable(state.run);

    if (state.activeNonExpiredJobs.length > 0) {
      if (hasStaleLeaseWithRecoverableRun) {
        await this.executeReclaim(repoId, state);
        return { action: 'reclaim' };
      }
      return { action: 'leave' };
    }

    if (hasStaleLeaseWithRecoverableRun) {
      if (!state.repoEnabled) {
        await this.executeReclaim(repoId, state);
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

  private async executeReclaim(repoId: RepositoryId, state: RepoState): Promise<void> {
    const worktreePath = this.deps.getWorktreePath?.(repoId) ?? '';
    const quarantineRoot = this.deps.getQuarantineRoot?.(repoId) ?? '';
    const baseRef = state.run?.baseBranch ?? 'HEAD';

    if (this.deps.worktreeRecovery && worktreePath) {
      const outcome = await this.deps.worktreeRecovery.prepare({
        repoId,
        runId: state.run!.uuid as RunId,
        worktreePath,
        baseRef,
        quarantineRoot,
      });
      if (!outcome.safe) {
        return;
      }
    } else {
      this.deps.resetWorktree(repoId);
    }

    if (this.deps.operationalRecovery && state.lease) {
      this.deps.operationalRecovery.commitLeaseReclamation({
        repoId,
        leaseToken: state.lease.leaseToken,
        workerId: state.lease.workerId,
        runId: state.lease.runId,
        now: this.deps.now(),
        expectedLeaseGeneration: {
          workerId: state.lease.workerId,
          runId: state.lease.runId,
        },
        auditReason: 'stale lease recovery',
      });
    }
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
