import { describe, it, expect, vi } from 'vitest';
import {
  createWorker,
  IssueNumber,
  JobId,
  RepositoryId,
  RunId,
  WorkerId,
  createJob,
  createRun,
  type Run,
  type Job,
  newClaimToken,
  type JobOwnership,
} from '@ai-sdlc/domain';
import {
  FakeRepositoryPort,
  FakeWorkerRegistryPort,
  FakeWorkerLeasePort,
} from '../../test-doubles/index.js';
import { workerLoop } from '../worker-loop.js';
import type { JobQueuePort, EnqueueJobInput, ClaimNextInput } from '../ports/job-queue-port.js';

const REPO_ID = RepositoryId('r1');

function makeRun(runId: string, repoId: RepositoryId = REPO_ID): Run {
  return createRun({
    uuid: runId,
    displayId: `disp-${runId}`,
    repoId,
    issueNumber: IssueNumber(1),
    startedAt: new Date(),
  });
}

const executeOk = async (_input: {
  run: Run;
  workerId: WorkerId;
  cwd: string;
  signal: AbortSignal;
}) => ({ ok: true as const });
const prepareOk = async (_input: { repoId: RepositoryId; runId: RunId; signal: AbortSignal }) => ({
  cwd: '/tmp/worktree',
});

class NoCheckJobQueuePort implements JobQueuePort {
  private jobs = new Map<JobId, Job>();

  enqueue(input: EnqueueJobInput): void {
    this.jobs.set(input.job.id, input.job);
  }

  claimNext(input: ClaimNextInput): Job | undefined {
    const queued = [...this.jobs.values()].filter(
      (j) => j.status === 'queued' && j.repoId === input.repoId && !input.skipJobIds?.has(j.id),
    );
    const next = queued[0];
    if (!next) return undefined;
    const token = newClaimToken();
    const claimed: Job = {
      ...next,
      status: 'claimed',
      claimedBy: input.workerId,
      claimToken: token,
      claimedAt: new Date(),
      claimExpiresAt: new Date(Date.now() + (input.ttlMs ?? 60_000)),
    };
    this.jobs.set(claimed.id, claimed);
    return claimed;
  }

  releaseClaim(owner: JobOwnership): void {
    const j = this.jobs.get(owner.jobId);
    if (!j) return;
    this.jobs.set(owner.jobId, {
      ...j,
      status: 'queued',
      claimedBy: undefined,
      claimToken: undefined,
      claimedAt: undefined,
      claimExpiresAt: undefined,
    });
  }

  resetToQueued(owner: JobOwnership): void {
    const j = this.jobs.get(owner.jobId);
    if (!j) return;
    this.jobs.set(owner.jobId, {
      ...j,
      status: 'queued',
      claimedBy: undefined,
      claimToken: undefined,
      claimedAt: undefined,
      claimExpiresAt: undefined,
    });
  }

  markRunning(owner: JobOwnership, _now: Date): void {
    const j = this.jobs.get(owner.jobId);
    if (j && j.claimToken === owner.claimToken) {
      this.jobs.set(j.id, { ...j, status: 'running' });
    }
  }

  markSucceeded(owner: JobOwnership, _now: Date): void {
    const j = this.jobs.get(owner.jobId);
    if (j && j.claimToken === owner.claimToken) {
      this.jobs.set(owner.jobId, { ...j, status: 'succeeded' });
    }
  }

  markFailed(owner: JobOwnership, _now: Date): void {
    const j = this.jobs.get(owner.jobId);
    if (j && j.claimToken === owner.claimToken) {
      this.jobs.set(owner.jobId, { ...j, status: 'failed' });
    }
  }

  markCancelled(owner: JobOwnership, _now: Date): void {
    const j = this.jobs.get(owner.jobId);
    if (j && j.claimToken === owner.claimToken) {
      this.jobs.set(owner.jobId, { ...j, status: 'cancelled' });
    }
  }

  listForRepo(_repoId: RepositoryId): Job[] {
    return [...this.jobs.values()];
  }

  listForRun(_runId: RunId): Job[] {
    return [...this.jobs.values()];
  }

  findById(jobId: JobId): Job | undefined {
    return this.jobs.get(jobId);
  }

  findExpiredClaims(_cutoff: Date): Job[] {
    return [];
  }

  reclaimStaleClaims(_cutoff: Date): number {
    return 0;
  }

  listActive(): Job[] {
    return [...this.jobs.values()].filter(
      (j) => j.status === 'queued' || j.status === 'claimed' || j.status === 'running',
    );
  }
}

class DisableOnReturnQueue implements JobQueuePort {
  private jobs = new Map<JobId, Job>();
  private _disableAfterClaim = false;
  private readonly repos: FakeRepositoryPort;

  constructor(repos: FakeRepositoryPort) {
    this.repos = repos;
  }

  set disableAfterClaim(v: boolean) {
    this._disableAfterClaim = v;
  }

  enqueue(input: EnqueueJobInput): void {
    this.jobs.set(input.job.id, input.job);
  }

  claimNext(input: ClaimNextInput): Job | undefined {
    const queued = [...this.jobs.values()].filter(
      (j) => j.status === 'queued' && j.repoId === input.repoId && !input.skipJobIds?.has(j.id),
    );
    const next = queued[0];
    if (!next) return undefined;
    const token = newClaimToken();
    const claimed: Job = {
      ...next,
      status: 'claimed',
      claimedBy: input.workerId,
      claimToken: token,
      claimedAt: new Date(),
      claimExpiresAt: new Date(Date.now() + (input.ttlMs ?? 60_000)),
    };
    this.jobs.set(claimed.id, claimed);
    if (this._disableAfterClaim) {
      const repo = this.repos.findById(REPO_ID);
      if (repo) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.repos as any).byId.set(REPO_ID, { ...repo, enabled: false });
      }
    }
    return claimed;
  }

  releaseClaim(owner: JobOwnership): void {
    const j = this.jobs.get(owner.jobId);
    if (!j) return;
    this.jobs.set(owner.jobId, {
      ...j,
      status: 'queued',
      claimedBy: undefined,
      claimToken: undefined,
      claimedAt: undefined,
      claimExpiresAt: undefined,
    });
  }

  resetToQueued(owner: JobOwnership): void {
    const j = this.jobs.get(owner.jobId);
    if (!j) return;
    this.jobs.set(owner.jobId, {
      ...j,
      status: 'queued',
      claimedBy: undefined,
      claimToken: undefined,
      claimedAt: undefined,
      claimExpiresAt: undefined,
    });
  }

  markRunning(owner: JobOwnership, _now: Date): void {
    const j = this.jobs.get(owner.jobId);
    if (j && j.claimToken === owner.claimToken) {
      this.jobs.set(j.id, { ...j, status: 'running' });
    }
  }

  markSucceeded(owner: JobOwnership, _now: Date): void {
    const j = this.jobs.get(owner.jobId);
    if (j && j.claimToken === owner.claimToken) {
      this.jobs.set(owner.jobId, { ...j, status: 'succeeded' });
    }
  }

  markFailed(owner: JobOwnership, _now: Date): void {
    const j = this.jobs.get(owner.jobId);
    if (j && j.claimToken === owner.claimToken) {
      this.jobs.set(owner.jobId, { ...j, status: 'failed' });
    }
  }

  markCancelled(owner: JobOwnership, _now: Date): void {
    const j = this.jobs.get(owner.jobId);
    if (j && j.claimToken === owner.claimToken) {
      this.jobs.set(owner.jobId, { ...j, status: 'cancelled' });
    }
  }

  listForRepo(_repoId: RepositoryId): Job[] {
    return [...this.jobs.values()];
  }

  listForRun(_runId: RunId): Job[] {
    return [...this.jobs.values()];
  }

  findById(jobId: JobId): Job | undefined {
    return this.jobs.get(jobId);
  }

  findExpiredClaims(_cutoff: Date): Job[] {
    return [];
  }

  reclaimStaleClaims(_cutoff: Date): number {
    return 0;
  }

  listActive(): Job[] {
    return [...this.jobs.values()].filter(
      (j) => j.status === 'queued' || j.status === 'claimed' || j.status === 'running',
    );
  }
}

describe('workerLoop disable policy', () => {
  describe('disabled_before_claim_blocks_admission', () => {
    it('an initially disabled Repository leaves its Job queued and performs no claim', async () => {
      const repos = new FakeRepositoryPort([
        {
          id: REPO_ID,
          owner: 'o',
          name: 'r1',
          fullName: 'o/r1',
          defaultBranch: 'main',
          localBasePath: '/x',
          enabled: false,
          maxConcurrentRuns: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      const queue = new NoCheckJobQueuePort();
      const registry = new FakeWorkerRegistryPort();
      const leases = new FakeWorkerLeasePort(registry);
      const now = new Date();
      registry.register(
        createWorker({ id: WorkerId('w1'), repoId: REPO_ID, hostname: 'h', processId: 1, now }),
      );

      queue.enqueue({
        job: createJob({
          id: JobId('j1'),
          runId: RunId('run-1'),
          repoId: REPO_ID,
          issueNumber: IssueNumber(1),
          createdAt: now,
        }),
      });

      const markBusy = vi.spyOn(registry, 'markBusy');
      const acquire = vi.spyOn(leases, 'acquire');

      await workerLoop(WorkerId('w1'), {
        registry,
        queue,
        leases,
        repos,
        repoId: REPO_ID,
        executeRun: executeOk,
        prepareWorktree: prepareOk,
        resetWorktree: (_repoId: import('@ai-sdlc/domain').RepositoryId) => {},
        isWorkerAlive: (_workerId: import('@ai-sdlc/domain').WorkerId) => true,
        recoverableRunIds: new Set<RunId>(),
        now: () => new Date(),
        ttlMs: 60_000,
        findRun: (runId: import('@ai-sdlc/domain').RunId) => makeRun(runId as string, REPO_ID),
      });

      expect(markBusy).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(queue.findById(JobId('j1'))?.status).toBe('queued');
    });
  });

  describe('post_claim_disable_releases_without_starting', () => {
    it('disabling immediately after claimNext releases the claim before markBusy, lease acquisition, markRunning, or worktree preparation', async () => {
      const repos = new FakeRepositoryPort([
        {
          id: REPO_ID,
          owner: 'o',
          name: 'r1',
          fullName: 'o/r1',
          defaultBranch: 'main',
          localBasePath: '/x',
          enabled: true,
          maxConcurrentRuns: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      const queue = new DisableOnReturnQueue(repos);
      const registry = new FakeWorkerRegistryPort();
      const leases = new FakeWorkerLeasePort(registry);
      const now = new Date();
      registry.register(
        createWorker({ id: WorkerId('w1'), repoId: REPO_ID, hostname: 'h', processId: 1, now }),
      );

      queue.enqueue({
        job: createJob({
          id: JobId('j1'),
          runId: RunId('run-1'),
          repoId: REPO_ID,
          issueNumber: IssueNumber(1),
          createdAt: now,
        }),
      });

      const markBusy = vi.spyOn(registry, 'markBusy');
      const acquire = vi.spyOn(leases, 'acquire');
      const releaseClaim = vi.spyOn(queue, 'releaseClaim');
      const prepareWorktree = vi.fn(prepareOk);
      const executeRun = vi.fn(executeOk);

      queue.disableAfterClaim = true;

      await workerLoop(WorkerId('w1'), {
        registry,
        queue,
        leases,
        repos,
        repoId: REPO_ID,
        executeRun,
        prepareWorktree,
        resetWorktree: (_repoId: import('@ai-sdlc/domain').RepositoryId) => {},
        isWorkerAlive: (_workerId: import('@ai-sdlc/domain').WorkerId) => true,
        recoverableRunIds: new Set<RunId>(),
        now: () => new Date(),
        ttlMs: 60_000,
        findRun: (runId: import('@ai-sdlc/domain').RunId) => makeRun(runId as string, REPO_ID),
      });

      expect(releaseClaim).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: JobId('j1'), workerId: WorkerId('w1') }),
      );
      expect(markBusy).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(prepareWorktree).not.toHaveBeenCalled();
      expect(executeRun).not.toHaveBeenCalled();
    });
  });

  describe('admitted_work_drains_after_disable', () => {
    it('disabling during prepareWorktree does not cancel the already-admitted Job', async () => {
      const repos = new FakeRepositoryPort([
        {
          id: REPO_ID,
          owner: 'o',
          name: 'r1',
          fullName: 'o/r1',
          defaultBranch: 'main',
          localBasePath: '/x',
          enabled: true,
          maxConcurrentRuns: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      const queue = new NoCheckJobQueuePort();
      const registry = new FakeWorkerRegistryPort();
      const leases = new FakeWorkerLeasePort(registry);
      const now = new Date();
      registry.register(
        createWorker({ id: WorkerId('w1'), repoId: REPO_ID, hostname: 'h', processId: 1, now }),
      );

      queue.enqueue({
        job: createJob({
          id: JobId('j1'),
          runId: RunId('run-1'),
          repoId: REPO_ID,
          issueNumber: IssueNumber(1),
          createdAt: now,
        }),
      });

      const prepareWorktree = vi.fn(
        async (_input: { repoId: RepositoryId; runId: RunId; signal: AbortSignal }) => {
          const repo = repos.findById(REPO_ID);
          if (repo) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (repos as any).byId.set(REPO_ID, { ...repo, enabled: false });
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
          return { cwd: '/tmp/worktree' };
        },
      );
      const executeRun = vi.fn(executeOk);

      await workerLoop(WorkerId('w1'), {
        registry,
        queue,
        leases,
        repos,
        repoId: REPO_ID,
        executeRun,
        prepareWorktree,
        resetWorktree: (_repoId: import('@ai-sdlc/domain').RepositoryId) => {},
        isWorkerAlive: (_workerId: import('@ai-sdlc/domain').WorkerId) => true,
        recoverableRunIds: new Set<RunId>(),
        now: () => new Date(),
        ttlMs: 60_000,
        findRun: (runId: import('@ai-sdlc/domain').RunId) => makeRun(runId as string, REPO_ID),
      });

      expect(executeRun).toHaveBeenCalled();
      expect(queue.findById(JobId('j1'))?.status).toBe('succeeded');
    });
  });
});
