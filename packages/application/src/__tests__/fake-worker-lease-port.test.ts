import { describe, expect, it } from 'vitest';
import {
  RepositoryId,
  RunId,
  WorkerId,
  WorkerLeaseConflictError,
  createWorker,
} from '@ai-sdlc/domain';
import { FakeWorkerLeasePort, FakeWorkerRegistryPort } from '../test-doubles/index.js';

const now0 = new Date('2026-01-01T00:00:00Z');
const repoId = RepositoryId('r1');

function makePorts() {
  const registry = new FakeWorkerRegistryPort();
  const leases = new FakeWorkerLeasePort(registry);
  return { registry, leases };
}

describe('FakeWorkerLeasePort', () => {
  it('two workers acquiring the same repo concurrently: exactly one wins', () => {
    const { registry, leases } = makePorts();
    registry.register(
      createWorker({ id: WorkerId('w1'), repoId, hostname: 'h', processId: 1, now: now0 }),
    );
    registry.register(
      createWorker({ id: WorkerId('w2'), repoId, hostname: 'h', processId: 2, now: now0 }),
    );
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
    registry.register(
      createWorker({
        id: WorkerId('w1'),
        repoId: RepositoryId('r1'),
        hostname: 'h',
        processId: 1,
        now: now0,
      }),
    );
    registry.register(
      createWorker({
        id: WorkerId('w2'),
        repoId: RepositoryId('r2'),
        hostname: 'h',
        processId: 2,
        now: now0,
      }),
    );
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

  it('release throws LeaseOwnershipLostError when lease already gone (reject zero-row updates)', () => {
    const { registry, leases } = makePorts();
    registry.register(
      createWorker({ id: WorkerId('w1'), repoId, hostname: 'h', processId: 1, now: now0 }),
    );
    const lease = leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    leases.release({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      leaseToken: lease.leaseToken,
    });
    expect(() =>
      leases.release({
        repoId: RepositoryId('r'),
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        leaseToken: lease.leaseToken,
      }),
    ).toThrow('WorkerLease ownership lost');
    expect(leases.current(RepositoryId('r'))).toBeUndefined();
  });

  it('release throws LeaseOwnershipLostError for wrong token', () => {
    const { registry, leases } = makePorts();
    registry.register(
      createWorker({ id: WorkerId('w1'), repoId, hostname: 'h', processId: 1, now: now0 }),
    );
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    expect(() =>
      leases.release({
        repoId: RepositoryId('r'),
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        leaseToken: 'wrong-token' as LeaseToken,
      }),
    ).toThrow('WorkerLease ownership lost');
  });

  it('lease acquisition allows an expired foreign generation to be replaced', () => {
    const { leases } = makePorts();
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const atExpiry = new Date(now0.getTime() + 60_000);
    const newLease = leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w2'),
      runId: RunId('run-2'),
      now: atExpiry,
      ttlMs: 60_000,
    });
    expect(newLease.workerId).toBe('w2');
    expect(newLease.runId).toBe('run-2');
  });

  it('acquire still throws WorkerLeaseConflictError when existing lease is unexpired', () => {
    const { leases } = makePorts();
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const beforeExpiry = new Date(now0.getTime() + 59_999);
    expect(() =>
      leases.acquire({
        repoId: RepositoryId('r'),
        workerId: WorkerId('w2'),
        runId: RunId('run-2'),
        now: beforeExpiry,
        ttlMs: 60_000,
      }),
    ).toThrow(WorkerLeaseConflictError);
  });

  it('stale lease token cannot heartbeat replacement generation', () => {
    const { leases } = makePorts();
    const w1Lease = leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const later = new Date(now0.getTime() + 120_000);
    leases.release({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      leaseToken: w1Lease.leaseToken,
    });
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w2'),
      runId: RunId('run-2'),
      now: later,
      ttlMs: 60_000,
    });
    expect(() =>
      leases.heartbeat({
        repoId: RepositoryId('r'),
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        now: later,
        newExpiresAt: new Date(later.getTime() + 60_000),
        leaseToken: w1Lease.leaseToken,
      }),
    ).toThrow('WorkerLease ownership lost');
    const currentLease = leases.current(RepositoryId('r'));
    expect(currentLease?.workerId).toBe('w2');
    expect(currentLease?.runId).toBe('run-2');
  });

  it('stale lease token cannot release replacement generation', () => {
    const { leases } = makePorts();
    const w1Lease = leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      now: now0,
      ttlMs: 60_000,
    });
    const later = new Date(now0.getTime() + 120_000);
    leases.release({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w1'),
      runId: RunId('run-1'),
      leaseToken: w1Lease.leaseToken,
    });
    leases.acquire({
      repoId: RepositoryId('r'),
      workerId: WorkerId('w2'),
      runId: RunId('run-2'),
      now: later,
      ttlMs: 60_000,
    });
    expect(() =>
      leases.release({
        repoId: RepositoryId('r'),
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        leaseToken: w1Lease.leaseToken,
      }),
    ).toThrow('WorkerLease ownership lost');
    const currentLease = leases.current(RepositoryId('r'));
    expect(currentLease?.workerId).toBe('w2');
    expect(currentLease?.runId).toBe('run-2');
  });
});
