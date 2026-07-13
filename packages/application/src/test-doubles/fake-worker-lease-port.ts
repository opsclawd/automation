import { type RepositoryId, type WorkerLease, WorkerLeaseConflictError } from '@ai-sdlc/domain';
import type {
  WorkerLeasePort,
  AcquireLeaseInput,
  HeartbeatLeaseInput,
  ReleaseLeaseInput,
  ReclaimExpiredInput,
} from '../ports/worker-lease-port.js';
import type { WorkerRegistryPort } from '../ports/worker-registry-port.js';

/**
 * In-memory fake WorkerLeasePort enforcing one active lease per Repository.
 *
 * The SQLite adapter (M8) MUST enforce the same uniqueness via a DB-level
 * constraint (e.g. a UNIQUE partial index on `repoId` where the lease is
 * active).  Relying on application-level locking is incorrect.
 *
 * JavaScript is single-threaded, so each method body is effectively atomic.
 * The SQLite adapter must use a transaction with atomic acquisition
 * (INSERT ... ON CONFLICT or equivalent) — this constraint is load-bearing.
 */
export class FakeWorkerLeasePort implements WorkerLeasePort {
  private leases = new Map<RepositoryId, WorkerLease>();

  constructor(private readonly registry: WorkerRegistryPort) {}

  acquire(input: AcquireLeaseInput): WorkerLease {
    const existing = this.leases.get(input.repoId);
    if (
      existing &&
      existing.expiresAt > input.now &&
      (existing.workerId !== input.workerId || existing.runId !== input.runId)
    ) {
      throw new WorkerLeaseConflictError(input.repoId, existing.workerId);
    }
    const lease: WorkerLease = {
      repoId: input.repoId,
      workerId: input.workerId,
      runId: input.runId,
      acquiredAt: input.now,
      heartbeatAt: input.now,
      expiresAt: new Date(input.now.getTime() + input.ttlMs),
    };
    this.leases.set(input.repoId, lease);
    return lease;
  }

  heartbeat(input: HeartbeatLeaseInput): void {
    const l = this.leases.get(input.repoId);
    if (!l || l.workerId !== input.workerId || l.runId !== input.runId) return;
    this.leases.set(input.repoId, { ...l, heartbeatAt: input.now, expiresAt: input.newExpiresAt });
  }

  release(input: ReleaseLeaseInput): void {
    const l = this.leases.get(input.repoId);
    if (!l || l.workerId !== input.workerId || l.runId !== input.runId) return;
    this.leases.delete(input.repoId);
  }

  current(repoId: RepositoryId): WorkerLease | undefined {
    return this.leases.get(repoId);
  }

  checkActiveLease(repoId: RepositoryId, now: Date): boolean {
    const l = this.leases.get(repoId);
    return l !== undefined && l.expiresAt.getTime() > now.getTime();
  }

  reclaimExpired(input: ReclaimExpiredInput): WorkerLease[] {
    const reclaimed: WorkerLease[] = [];
    for (const lease of [...this.leases.values()]) {
      if (input.now <= lease.expiresAt) continue;
      const worker = this.registry.findById(lease.workerId, lease.repoId);
      const workerStale =
        !input.isWorkerAlive(lease.workerId) ||
        worker?.status === 'stopping' ||
        worker?.status === 'unhealthy';
      if (!workerStale) continue;
      if (!input.recoverableRunIds.has(lease.runId)) continue;
      input.resetWorktree(lease.repoId);
      input.onReclaimed({
        repoId: lease.repoId,
        previousWorkerId: lease.workerId,
        previousRunId: lease.runId,
        reclaimedByWorkerId: input.reclaimedByWorkerId,
        reason: 'expired + worker stale + run recoverable',
      });
      this.leases.delete(lease.repoId);
      reclaimed.push(lease);
    }
    return reclaimed;
  }
}
