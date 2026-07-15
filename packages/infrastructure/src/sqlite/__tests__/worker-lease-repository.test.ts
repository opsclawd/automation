import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RepositoryId, RunId, WorkerId, WorkerLeaseConflictError } from '@ai-sdlc/domain';
import { openDatabase, applyMigrations } from '../../index.js';
import { WorkerLeaseRepository } from '../worker-lease-repository.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-wlr-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

const now0 = new Date('2026-01-01T00:00:00Z');

describe('WorkerLeaseRepository', () => {
  it('acquire: returns the stored lease with correct fields', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    const lease = repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    expect(lease.repoId).toBe('repo-a');
    expect(lease.workerId).toBe('w1');
    expect(lease.runId).toBe('run-1');
    expect(lease.acquiredAt).toEqual(now0);
    expect(lease.heartbeatAt).toEqual(now0);
    expect(lease.expiresAt).toEqual(new Date(now0.getTime() + 60_000));
    db.close();
  });

  it('acquire: two workers on the same repo — exactly one wins', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    expect(() =>
      repo.acquire({
        repoId: RepositoryId('repo-a'),
        workerId: WorkerId('w2'),
        runId: RunId('run-2'),
        now: now0,
        ttlMs: 60_000,
      }),
    ).toThrow(WorkerLeaseConflictError);
    db.close();
  });

  it('acquire: two workers on different repos both succeed', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    repo.acquire({
      repoId: RepositoryId('repo-b'),
      workerId: WorkerId('w2'),
      runId: RunId('run-2'),
      now: now0,
      ttlMs: 60_000,
    });
    expect(repo.current(RepositoryId('repo-a'))?.workerId).toBe('w1');
    expect(repo.current(RepositoryId('repo-b'))?.workerId).toBe('w2');
    db.close();
  });

  it('current: returns undefined when no lease exists', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    expect(repo.current(RepositoryId('repo-a'))).toBeUndefined();
    db.close();
  });

  it('current: round-trips a stored lease including date fields', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const lease = repo.current(RepositoryId('repo-a'));
    expect(lease?.acquiredAt).toEqual(now0);
    expect(lease?.heartbeatAt).toEqual(now0);
    expect(lease?.expiresAt).toEqual(new Date(now0.getTime() + 60_000));
    db.close();
  });

  it('heartbeat: updates heartbeatAt and expiresAt', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    const lease = repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const now1 = new Date(now0.getTime() + 30_000);
    const newExpiry = new Date(now0.getTime() + 90_000);
    repo.heartbeat({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now1,
      newExpiresAt: newExpiry,
      leaseToken: lease.leaseToken,
    });
    const current = repo.current(RepositoryId('repo-a'));
    expect(current?.heartbeatAt).toEqual(now1);
    expect(current?.expiresAt).toEqual(newExpiry);
    db.close();
  });

  it('heartbeat: throws LeaseOwnershipLostError for wrong token', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const now1 = new Date(now0.getTime() + 30_000);
    expect(() =>
      repo.heartbeat({
        repoId: RepositoryId('repo-a'),
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        now: now1,
        newExpiresAt: now1,
        leaseToken: 'wrong-token' as LeaseToken,
      }),
    ).toThrow('WorkerLease ownership lost');
    db.close();
  });

  it('heartbeat: throws LeaseOwnershipLostError for wrong workerId even with correct token', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    const lease = repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const now1 = new Date(now0.getTime() + 30_000);
    expect(() =>
      repo.heartbeat({
        repoId: RepositoryId('repo-a'),
        workerId: WorkerId('wrong-worker'),
        runId: RunId('run-1'),
        now: now1,
        newExpiresAt: now1,
        leaseToken: lease.leaseToken,
      }),
    ).toThrow('WorkerLease ownership lost');
    db.close();
  });

  it('release: removes the lease so current() returns undefined', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    const lease = repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    repo.release({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      leaseToken: lease.leaseToken,
    });
    expect(repo.current(RepositoryId('repo-a'))).toBeUndefined();
    db.close();
  });

  it('release: throws LeaseOwnershipLostError for wrong token', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    expect(() =>
      repo.release({
        repoId: RepositoryId('repo-a'),
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        leaseToken: 'wrong-token' as LeaseToken,
      }),
    ).toThrow('WorkerLease ownership lost');
    db.close();
  });

  it('release: throws LeaseOwnershipLostError for wrong workerId even with correct token', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    const lease = repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    expect(() =>
      repo.release({
        repoId: RepositoryId('repo-a'),
        workerId: WorkerId('wrong-worker'),
        runId: RunId('run-1'),
        leaseToken: lease.leaseToken,
      }),
    ).toThrow('WorkerLease ownership lost');
    db.close();
  });

  it('reclaimExpired: does not reclaim unexpired leases', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const reclaimed = repo.reclaimExpired({
      now: new Date(now0.getTime() + 30_000),
      recoverableRunIds: new Set([RunId('run-1')]),
      isWorkerAlive: () => false,
      resetWorktree: () => {},
      reclaimedByWorkerId: WorkerId('w2'),
      onReclaimed: () => {},
    });
    expect(reclaimed).toEqual([]);
    db.close();
  });

  it('reclaimExpired: does not reclaim when worker is still alive', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const reclaimed = repo.reclaimExpired({
      now: new Date(now0.getTime() + 120_000),
      recoverableRunIds: new Set([RunId('run-1')]),
      isWorkerAlive: () => true,
      resetWorktree: () => {},
      reclaimedByWorkerId: WorkerId('w2'),
      onReclaimed: () => {},
    });
    expect(reclaimed).toEqual([]);
    db.close();
  });

  it('reclaimExpired: does not reclaim when run is not recoverable', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const reclaimed = repo.reclaimExpired({
      now: new Date(now0.getTime() + 120_000),
      recoverableRunIds: new Set(),
      isWorkerAlive: () => false,
      resetWorktree: () => {},
      reclaimedByWorkerId: WorkerId('w2'),
      onReclaimed: () => {},
    });
    expect(reclaimed).toEqual([]);
    db.close();
  });

  it('reclaimExpired: succeeds when all conditions hold and fires callbacks', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const onReclaimed = vi.fn();
    const resetWorktree = vi.fn();
    const reclaimed = repo.reclaimExpired({
      now: new Date(now0.getTime() + 120_000),
      recoverableRunIds: new Set([RunId('run-1')]),
      isWorkerAlive: () => false,
      resetWorktree,
      reclaimedByWorkerId: WorkerId('w2'),
      onReclaimed,
    });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0].repoId).toBe('repo-a');
    expect(resetWorktree).toHaveBeenCalledWith(RepositoryId('repo-a'));
    expect(onReclaimed).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo-a',
        previousWorkerId: 'w1',
        previousRunId: 'run-1',
        reclaimedByWorkerId: 'w2',
      }),
    );
    expect(repo.current(RepositoryId('repo-a'))).toBeUndefined();
    db.close();
  });

  it('reclaimExpired: preserves the lease when onReclaimed throws', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    expect(() =>
      repo.reclaimExpired({
        now: new Date(now0.getTime() + 120_000),
        recoverableRunIds: new Set([RunId('run-1')]),
        isWorkerAlive: () => false,
        resetWorktree: () => {},
        reclaimedByWorkerId: WorkerId('w2'),
        onReclaimed: () => {
          throw new Error('requeue failed');
        },
      }),
    ).toThrow(AggregateError);
    expect(repo.current(RepositoryId('repo-a'))?.workerId).toBe('w1');
    db.close();
  });

  it('acquire after release succeeds (repo re-acquisition)', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    const lease = repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    repo.release({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      leaseToken: lease.leaseToken,
    });
    const lease2 = repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w2'),
      runId: RunId('run-2'),
      now: now0,
      ttlMs: 60_000,
    });
    expect(lease2.workerId).toBe('w2');
    expect(lease2.leaseToken).toBeDefined();
    db.close();
  });

  it('lease acquisition refuses an expired foreign generation', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const atExpiry = new Date(now0.getTime() + 60_000);
    expect(() =>
      repo.acquire({
        repoId: RepositoryId('repo-a'),
        workerId: WorkerId('w2'),
        runId: RunId('run-2'),
        now: atExpiry,
        ttlMs: 60_000,
      }),
    ).toThrow(WorkerLeaseConflictError);
    db.close();
  });

  it('stale lease token cannot heartbeat replacement generation', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    const lease1 = repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    // Manually delete the lease, pretending it was reclaimed/released, then insert a replacement
    repo.release({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      leaseToken: lease1.leaseToken,
    });
    const lease2 = repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w2'),
      runId: RunId('run-2'),
      now: now0,
      ttlMs: 60_000,
    });

    const now1 = new Date(now0.getTime() + 30_000);
    expect(() =>
      repo.heartbeat({
        repoId: RepositoryId('repo-a'),
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        now: now1,
        newExpiresAt: new Date(now1.getTime() + 60_000),
        leaseToken: lease1.leaseToken,
      }),
    ).toThrow('WorkerLease ownership lost');
    // Ensure the database row is still lease2
    const current = repo.current(RepositoryId('repo-a'));
    expect(current?.workerId).toBe('w2');
    expect(current?.leaseToken).toBe(lease2.leaseToken);
    db.close();
  });

  it('stale lease token cannot release replacement generation', () => {
    const db = freshDb();
    const repo = new WorkerLeaseRepository(db);
    const lease1 = repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    // Manually delete the lease, pretending it was reclaimed/released, then insert a replacement
    repo.release({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      leaseToken: lease1.leaseToken,
    });
    const lease2 = repo.acquire({
      repoId: RepositoryId('repo-a'),
      workerId: WorkerId('w2'),
      runId: RunId('run-2'),
      now: now0,
      ttlMs: 60_000,
    });

    expect(() =>
      repo.release({
        repoId: RepositoryId('repo-a'),
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        leaseToken: lease1.leaseToken,
      }),
    ).toThrow('WorkerLease ownership lost');
    // Ensure the database row is still lease2
    const current = repo.current(RepositoryId('repo-a'));
    expect(current?.workerId).toBe('w2');
    expect(current?.leaseToken).toBe(lease2.leaseToken);
    db.close();
  });
});
