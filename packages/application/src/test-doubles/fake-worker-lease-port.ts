import {
  type RepositoryId,
  type WorkerId,
  type WorkerLease,
  WorkerLeaseConflictError,
} from '@ai-sdlc/domain';
import type {
  WorkerLeasePort,
  AcquireLeaseInput,
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
    if (existing) throw new WorkerLeaseConflictError(input.repoId, existing.workerId);
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

  heartbeat(repoId: RepositoryId, workerId: WorkerId, now: Date, newExpiresAt: Date): void {
    const l = this.leases.get(repoId);
    if (!l || l.workerId !== workerId) return;
    this.leases.set(repoId, { ...l, heartbeatAt: now, expiresAt: newExpiresAt });
  }

  release(repoId: RepositoryId, workerId: WorkerId): void {
    const l = this.leases.get(repoId);
    if (!l || l.workerId !== workerId) return;
    this.leases.delete(repoId);
  }

  current(repoId: RepositoryId): WorkerLease | undefined {
    return this.leases.get(repoId);
  }

  reclaimExpired(input: ReclaimExpiredInput): WorkerLease[] {
    const reclaimed: WorkerLease[] = [];
    for (const lease of [...this.leases.values()]) {
      if (input.now <= lease.expiresAt) continue;
      const worker = this.registry.findById(lease.workerId);
      const workerStale =
        !input.isWorkerAlive(lease.workerId) ||
        worker?.status === 'stopping' ||
        worker?.status === 'unhealthy';
      if (!workerStale) continue;
      if (!input.recoverableRunIds.has(lease.runId)) continue;
      input.resetWorktree(lease.repoId);
      this.leases.delete(lease.repoId);
      input.onReclaimed({
        repoId: lease.repoId,
        previousWorkerId: lease.workerId,
        previousRunId: lease.runId,
        reason: 'expired + worker stale + run recoverable',
      });
      reclaimed.push(lease);
    }
    return reclaimed;
  }
}
