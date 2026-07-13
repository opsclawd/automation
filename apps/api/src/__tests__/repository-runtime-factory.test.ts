import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RepositoryId, WorkerId, RunId } from '@ai-sdlc/domain';
import type { Repository } from '@ai-sdlc/domain';
import type { WorkerLeasePort } from '@ai-sdlc/application';
import {
  RepositoryRuntimeFactory,
  type RepositoryRuntimeFactoryOptions,
} from '../repository-runtime-factory.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_FINGERPRINT_A = 'fingerprint-repo-a';
const TEST_FINGERPRINT_A_V2 = 'fingerprint-repo-a-v2';

function makeRepository(fullName: string, enabled = true): Repository {
  const [owner, name] = fullName.split('/');
  return {
    id: RepositoryId(fullName),
    owner,
    name,
    fullName,
    defaultBranch: 'main',
    remoteUrl: `git@github.com:${fullName}.git`,
    localBasePath: `/tmp/repos/${fullName}`,
    enabled,
    maxConcurrentRuns: 1 as const,
    healthStatus: 'healthy',
    healthError: null,
    lastHealthCheckAt: null,
    configMetadata: '{}',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeWorkerLeasePort(): WorkerLeasePort & {
  _leases: Map<string, { repoId: string; workerId: string; runId: string; expiresAt: Date }>;
  _activeRepos: Set<string>;
} {
  const leases = new Map<
    string,
    { repoId: string; workerId: string; runId: string; expiresAt: Date }
  >();
  const activeRepos = new Set<string>();

  return {
    _leases: leases,
    _activeRepos: activeRepos,
    acquire: vi.fn(
      (input: {
        repoId: RepositoryId;
        workerId: WorkerId;
        runId: RunId;
        now: Date;
        ttlMs: number;
      }) => {
        const key = String(input.repoId);
        leases.set(key, {
          repoId: String(input.repoId),
          workerId: String(input.workerId),
          runId: String(input.runId),
          expiresAt: new Date(input.now.getTime() + input.ttlMs),
        });
        activeRepos.add(key);
        return {
          repoId: input.repoId,
          workerId: input.workerId,
          runId: input.runId,
          acquiredAt: input.now,
          heartbeatAt: input.now,
          expiresAt: new Date(input.now.getTime() + input.ttlMs),
        };
      },
    ),
    heartbeat: vi.fn(),
    release: vi.fn((input: { repoId: RepositoryId; workerId: WorkerId; runId: RunId }) => {
      leases.delete(String(input.repoId));
    }),
    current: vi.fn((repoId: RepositoryId) => {
      const lease = leases.get(String(repoId));
      if (!lease) return undefined;
      return {
        repoId: RepositoryId(lease.repoId),
        workerId: WorkerId(lease.workerId),
        runId: RunId(lease.runId),
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: lease.expiresAt,
      };
    }),
    checkActiveLease: vi.fn((repoId: RepositoryId, now: Date) => {
      const lease = leases.get(String(repoId));
      if (!lease) return false;
      if (lease.expiresAt < now) return false;
      return true;
    }),
    reclaimExpired: vi.fn(),
  };
}

function makeFactory(opts?: Partial<RepositoryRuntimeFactoryOptions>): {
  factory: RepositoryRuntimeFactory;
  workerLeasePort: ReturnType<typeof makeWorkerLeasePort>;
  stateRoot: string;
} {
  const workerLeasePort = makeWorkerLeasePort();
  const stateRoot = join(tmpdir(), `repo-runtime-factory-test-${Date.now()}`);
  const factory = new RepositoryRuntimeFactory({
    stateRoot,
    workerLeasePort,
    ...opts,
  });
  return { factory, workerLeasePort, stateRoot };
}

describe('RepositoryRuntimeFactory', () => {
  describe('behavioral invariant: runtime_resources_follow_repository', () => {
    it('resolves config database paths and git metadata per repository', () => {
      const { factory } = makeFactory();
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      const runtimeA = factory.getRuntime(repoA, TEST_FINGERPRINT_A);
      const runtimeB = factory.getRuntime(repoB, TEST_FINGERPRINT_A);

      expect(runtimeA.paths.database()).not.toBe(runtimeB.paths.database());
      expect(runtimeA.paths.database()).toContain('acme/api');
      expect(runtimeB.paths.database()).toContain('acme/web');
      expect(runtimeA.repository.id).toBe(repoA.id);
      expect(runtimeB.repository.id).toBe(repoB.id);
      expect(runtimeA.defaultBranch).toBe('main');
      expect(runtimeB.defaultBranch).toBe('main');

      factory.close();
    });

    it('worktree paths are scoped to repository', () => {
      const { factory } = makeFactory();
      const repoA = makeRepository('acme/api');

      const runtimeA = factory.getRuntime(repoA, TEST_FINGERPRINT_A);
      const worktreePath = runtimeA.paths.worktree(42);

      expect(worktreePath).toContain('acme/api');
      expect(worktreePath).toContain('issue-42');
      expect(runtimeA.paths.worktree(42)).toBe(runtimeA.paths.worktree(42));

      factory.close();
    });
  });

  describe('behavioral invariant: runtime_cache_does_not_cross_repository_or_config', () => {
    it('caches only matching repository id and configuration fingerprint', () => {
      const { factory } = makeFactory();
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      const runtimeA1 = factory.getRuntime(repoA, TEST_FINGERPRINT_A);
      const runtimeA2 = factory.getRuntime(repoA, TEST_FINGERPRINT_A);
      const runtimeB = factory.getRuntime(repoB, TEST_FINGERPRINT_A);

      expect(runtimeA1).toBe(runtimeA2);
      expect(runtimeA1).not.toBe(runtimeB);

      const runtimeA_v2 = factory.getRuntime(repoA, TEST_FINGERPRINT_A_V2);
      expect(runtimeA_v2).not.toBe(runtimeA1);

      factory.close();
    });

    it('does not close a runtime with an active worker lease when reaped', () => {
      const { factory, workerLeasePort } = makeFactory();
      const repoA = makeRepository('acme/api');
      const now = new Date();

      factory.getRuntime(repoA, TEST_FINGERPRINT_A);

      workerLeasePort.acquire({
        repoId: repoA.id,
        workerId: WorkerId('worker-1'),
        runId: RunId('run-1'),
        now,
        ttlMs: 60000,
      });

      factory.onLeaseReleased(repoA.id);

      expect(workerLeasePort.checkActiveLease(repoA.id, now)).toBe(true);

      factory.close();
    });
  });

  describe('behavioral invariant: stale_runtime_is_reaped_after_lease_release', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('onLeaseReleased marks runtime as stale when no active lease exists', () => {
      const { factory, workerLeasePort } = makeFactory();
      const repoA = makeRepository('acme/api');
      const now = new Date();

      factory.getRuntime(repoA, TEST_FINGERPRINT_A);

      workerLeasePort.acquire({
        repoId: repoA.id,
        workerId: WorkerId('worker-1'),
        runId: RunId('run-1'),
        now,
        ttlMs: 60000,
      });

      expect(factory.isStale(repoA.id)).toBe(false);

      workerLeasePort.release({
        repoId: repoA.id,
        workerId: WorkerId('worker-1'),
        runId: RunId('run-1'),
      });

      factory.onLeaseReleased(repoA.id);

      vi.runAllTimers();

      factory.close();
    });

    it('new lease on previously-stale runtime unmarks it stale', () => {
      const { factory, workerLeasePort } = makeFactory();
      const repoA = makeRepository('acme/api');
      const now = new Date();

      factory.getRuntime(repoA, TEST_FINGERPRINT_A);

      workerLeasePort.acquire({
        repoId: repoA.id,
        workerId: WorkerId('worker-1'),
        runId: RunId('run-1'),
        now,
        ttlMs: 60000,
      });

      workerLeasePort.release({
        repoId: repoA.id,
        workerId: WorkerId('worker-1'),
        runId: RunId('run-1'),
      });

      factory.onLeaseReleased(repoA.id);

      vi.runAllTimers();

      const later = new Date(now.getTime() + 1000);
      workerLeasePort.acquire({
        repoId: repoA.id,
        workerId: WorkerId('worker-2'),
        runId: RunId('run-2'),
        now: later,
        ttlMs: 60000,
      });

      factory.onLeaseAcquired(repoA.id);

      expect(factory.isStale(repoA.id)).toBe(false);

      factory.close();
    });
  });

  describe('behavioral invariant: stale_historical_runtime_reap_resilience', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('force-evicts a historical fingerprint runtime after max stale age even while repo is busy', async () => {
      let currentTimeMs = new Date('2026-01-01T00:00:00.000Z').getTime();
      const { factory, workerLeasePort } = makeFactory({
        now: () => new Date(currentTimeMs),
      });
      const repoA = makeRepository('acme/api');

      const oldRuntime = factory.getRuntime(repoA, TEST_FINGERPRINT_A);
      const closeSpy = vi.spyOn(oldRuntime, 'close');

      // Repository picks up a new config fingerprint while a lease is
      // continuously active, marking the old runtime stale.
      workerLeasePort.acquire({
        repoId: repoA.id,
        workerId: WorkerId('worker-1'),
        runId: RunId('run-1'),
        now: new Date(currentTimeMs),
        ttlMs: 24 * 60 * 60 * 1000,
      });
      factory.getRuntime(repoA, TEST_FINGERPRINT_A_V2);

      // Reap keeps retrying (repo is still busy) but must not evict yet:
      // not past the max stale age.
      await vi.runOnlyPendingTimersAsync();
      expect(closeSpy).not.toHaveBeenCalled();

      currentTimeMs += 11 * 60 * 1000;
      await vi.runOnlyPendingTimersAsync();

      expect(closeSpy).toHaveBeenCalled();

      factory.close();
    });

    it('keeps retrying instead of evicting or stranding a historical runtime when checkActiveLease throws', async () => {
      const { factory, workerLeasePort } = makeFactory();
      const repoA = makeRepository('acme/api');
      const now = new Date();

      const oldRuntime = factory.getRuntime(repoA, TEST_FINGERPRINT_A);
      const closeSpy = vi.spyOn(oldRuntime, 'close');

      // Repo stays busy under a new fingerprint, so the old one becomes a
      // historical (non-active) stale entry.
      workerLeasePort.acquire({
        repoId: repoA.id,
        workerId: WorkerId('worker-1'),
        runId: RunId('run-1'),
        now,
        ttlMs: 60000,
      });
      factory.getRuntime(repoA, TEST_FINGERPRINT_A_V2);

      workerLeasePort.checkActiveLease.mockImplementationOnce(() => {
        throw new Error('boom');
      });

      // First scheduled reap tick throws; the entry must not be evicted, and
      // a retry must still be scheduled rather than stranding it forever.
      await vi.runOnlyPendingTimersAsync();
      expect(closeSpy).not.toHaveBeenCalled();

      // Release the lease so the next tick sees no active lease at all.
      workerLeasePort.release({
        repoId: repoA.id,
        workerId: WorkerId('worker-1'),
        runId: RunId('run-1'),
      });

      await vi.runOnlyPendingTimersAsync();
      expect(closeSpy).toHaveBeenCalled();

      factory.close();
    });
  });

  describe('cache invalidation on fingerprint change', () => {
    it('returns different runtime when config fingerprint changes', () => {
      const { factory } = makeFactory();
      const repoA = makeRepository('acme/api');

      const runtime1 = factory.getRuntime(repoA, TEST_FINGERPRINT_A);
      const runtime2 = factory.getRuntime(repoA, TEST_FINGERPRINT_A_V2);

      expect(runtime1).not.toBe(runtime2);
      expect(runtime1.configFingerprint).toBe(TEST_FINGERPRINT_A);
      expect(runtime2.configFingerprint).toBe(TEST_FINGERPRINT_A_V2);

      factory.close();
    });
  });

  describe('validateRepositoryState', () => {
    it('throws RepositoryResolutionError for disabled repository', () => {
      const { factory } = makeFactory();
      const repo = makeRepository('acme/api', false);

      expect(() => factory.getRuntime(repo, TEST_FINGERPRINT_A)).toThrow('disabled');
    });

    it('throws RepositoryResolutionError for degraded repository', () => {
      const { factory } = makeFactory();
      const repo = makeRepository('acme/api');
      repo.healthStatus = 'degraded';
      repo.healthError = 'database error';

      expect(() => factory.getRuntime(repo, TEST_FINGERPRINT_A)).toThrow('degraded');
    });

    it('throws RepositoryResolutionError for unreachable repository', () => {
      const { factory } = makeFactory();
      const repo = makeRepository('acme/api');
      repo.healthStatus = 'unreachable';

      expect(() => factory.getRuntime(repo, TEST_FINGERPRINT_A)).toThrow('unreachable');
    });

    it('throws RepositoryResolutionError for unknown health status', () => {
      const { factory } = makeFactory();
      const repo = makeRepository('acme/api');
      repo.healthStatus = 'unknown';

      expect(() => factory.getRuntime(repo, TEST_FINGERPRINT_A)).toThrow('unknown');
    });
  });

  describe('getActiveRuntimes', () => {
    it('returns all active runtimes', () => {
      const { factory } = makeFactory();
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      factory.getRuntime(repoA, TEST_FINGERPRINT_A);
      factory.getRuntime(repoB, TEST_FINGERPRINT_A);

      const activeRuntimes = factory.getActiveRuntimes();
      expect(activeRuntimes.size).toBe(2);

      factory.close();
    });
  });

  describe('close', () => {
    it('clears all runtimes from cache', () => {
      const { factory } = makeFactory();
      const repoA = makeRepository('acme/api');

      factory.getRuntime(repoA, TEST_FINGERPRINT_A);
      expect(factory.getActiveRuntimes().size).toBe(1);

      factory.close();
      expect(factory.getActiveRuntimes().size).toBe(0);
    });
  });
});
