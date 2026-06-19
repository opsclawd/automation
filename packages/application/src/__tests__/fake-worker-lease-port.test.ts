import { describe, expect, it, vi } from 'vitest';
import {
  RepositoryId,
  RunId,
  WorkerId,
  WorkerLeaseConflictError,
  createWorker,
} from '@ai-sdlc/domain';
import { FakeWorkerLeasePort, FakeWorkerRegistryPort } from '../test-doubles/index.js';

const now0 = new Date('2026-01-01T00:00:00Z');

function makePorts() {
  const registry = new FakeWorkerRegistryPort();
  const leases = new FakeWorkerLeasePort(registry);
  return { registry, leases };
}

describe('FakeWorkerLeasePort', () => {
  it('two workers acquiring the same repo concurrently: exactly one wins', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    registry.register(createWorker({ id: WorkerId('w2'), hostname: 'h', processId: 2, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    expect(() =>
      leases.acquire({
        repoId: RepositoryId('r'),
        workerId: WorkerId('w2'),
        runId: RunId('run-2'),
        now: now0,
        ttlMs: 60_000,
      }),
    ).toThrow(WorkerLeaseConflictError);
  });

  it('two workers acquiring different repos: both succeed', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    registry.register(createWorker({ id: WorkerId('w2'), hostname: 'h', processId: 2, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r1'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    leases.acquire({
      repoId: RepositoryId('r2'),
      workerId: WorkerId('w2'),
      runId: RunId('run-2'),
      now: now0,
      ttlMs: 60_000,
    });
    expect(leases.current(RepositoryId('r1'))?.workerId).toBe('w1');
    expect(leases.current(RepositoryId('r2'))?.workerId).toBe('w2');
  });

  it('release is idempotent', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    leases.release(RepositoryId('r'), WorkerId('w1'));
    leases.release(RepositoryId('r'), WorkerId('w1'));
    expect(leases.current(RepositoryId('r'))).toBeUndefined();
  });

  it('reclaimExpired does not reclaim unexpired leases', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const reclaimed = leases.reclaimExpired({
      now: new Date(now0.getTime() + 30_000),
      recoverableRunIds: new Set([RunId('run-1')]),
      isWorkerAlive: () => false,
      resetWorktree: () => {},
      reclaimedByWorkerId: WorkerId('w2'),
      onReclaimed: () => {},
    });
    expect(reclaimed).toEqual([]);
  });

  it('reclaimExpired requires worker stale or unhealthy', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const reclaimed = leases.reclaimExpired({
      now: new Date(now0.getTime() + 120_000),
      recoverableRunIds: new Set([RunId('run-1')]),
      isWorkerAlive: () => true,
      resetWorktree: () => {},
      reclaimedByWorkerId: WorkerId('w2'),
      onReclaimed: () => {},
    });
    expect(reclaimed).toEqual([]);
  });

  it('reclaimExpired requires run to be recoverable', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const reclaimed = leases.reclaimExpired({
      now: new Date(now0.getTime() + 120_000),
      recoverableRunIds: new Set(),
      isWorkerAlive: () => false,
      resetWorktree: () => {},
      reclaimedByWorkerId: WorkerId('w2'),
      onReclaimed: () => {},
    });
    expect(reclaimed).toEqual([]);
  });

  it('reclaimExpired succeeds when all conditions hold and emits onReclaimed', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const onReclaimed = vi.fn();
    const resetWorktree = vi.fn();
    const reclaimed = leases.reclaimExpired({
      now: new Date(now0.getTime() + 120_000),
      recoverableRunIds: new Set([RunId('run-1')]),
      isWorkerAlive: () => false,
      resetWorktree,
      reclaimedByWorkerId: WorkerId('w2'),
      onReclaimed,
    });
    expect(reclaimed).toHaveLength(1);
    expect(resetWorktree).toHaveBeenCalledWith(RepositoryId('r'));
    expect(onReclaimed).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'r',
        previousWorkerId: 'w1',
        previousRunId: 'run-1',
        reclaimedByWorkerId: 'w2',
      }),
    );
    expect(leases.current(RepositoryId('r'))).toBeUndefined();
  });

  it('reclaimExpired preserves the lease when onReclaimed throws', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });

    // onReclaimed requeues the claimed/running job; if that write fails the lease
    // MUST NOT be deleted, otherwise the repo is left unprotected with a
    // non-claimable job still recorded as active. See worker-lease-port contract.
    expect(() =>
      leases.reclaimExpired({
        now: new Date(now0.getTime() + 120_000),
        recoverableRunIds: new Set([RunId('run-1')]),
        isWorkerAlive: () => false,
        resetWorktree: () => {},
        reclaimedByWorkerId: WorkerId('w2'),
        onReclaimed: () => {
          throw new Error('requeue failed');
        },
      }),
    ).toThrow('requeue failed');

    expect(leases.current(RepositoryId('r'))?.workerId).toBe('w1');
  });

  it('reclaimExpired succeeds when worker is marked unhealthy even if isWorkerAlive returns true', () => {
    const { registry, leases } = makePorts();
    registry.register(createWorker({ id: WorkerId('w1'), hostname: 'h', processId: 1, now: now0 }));
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    registry.markUnhealthy(WorkerId('w1'));
    const reclaimed = leases.reclaimExpired({
      now: new Date(now0.getTime() + 120_000),
      recoverableRunIds: new Set([RunId('run-1')]),
      isWorkerAlive: () => true,
      resetWorktree: () => {},
      reclaimedByWorkerId: WorkerId('w2'),
      onReclaimed: () => {},
    });
    expect(reclaimed).toHaveLength(1);
  });
});
