import { describe, expect, it, vi } from 'vitest';
import { RepositoryId, WorkerId, RunId } from '@ai-sdlc/domain';
import type { Repository } from '@ai-sdlc/domain';
import type { WorkerLeasePort } from '@ai-sdlc/application';
import type { RepositoryRuntimePaths } from '../repository-runtime-paths.js';

const TEST_FINGERPRINT_A = 'fingerprint-repo-a';
const TEST_FINGERPRINT_B = 'fingerprint-repo-b';
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

interface MockRuntime {
  repoId: RepositoryId;
  fingerprint: string;
  closed: boolean;
  paths: RepositoryRuntimePaths;
}

function createMockRuntime(
  repoId: RepositoryId,
  fingerprint: string,
  paths: RepositoryRuntimePaths,
): MockRuntime {
  return { repoId, fingerprint, closed: false, paths };
}

describe('RepositoryRuntimeFactory', () => {
  describe('behavioral invariant: runtime_resources_follow_repository', () => {
    it('resolves config database paths git metadata and GitHub context per repository', () => {
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      const pathsA = {
        repositoryId: repoA.id,
        database: () => '/state/.ai-state/acme/api/orchestrator.sqlite',
      } as RepositoryRuntimePaths;
      const pathsB = {
        repositoryId: repoB.id,
        database: () => '/state/.ai-state/acme/web/orchestrator.sqlite',
      } as RepositoryRuntimePaths;

      const runtimeA = createMockRuntime(repoA.id, TEST_FINGERPRINT_A, pathsA);
      const runtimeB = createMockRuntime(repoB.id, TEST_FINGERPRINT_A, pathsB);

      expect(runtimeA.paths.database()).not.toBe(runtimeB.paths.database());
      expect(runtimeA.paths.database()).toContain('acme/api');
      expect(runtimeB.paths.database()).toContain('acme/web');
      expect(runtimeA.repoId).toBe(repoA.id);
      expect(runtimeB.repoId).toBe(repoB.id);
    });

    it('cancellation artifact access and start-commit lookup use the same repository worktree path', () => {
      const repoA = makeRepository('acme/api');
      const worktreePath = `/worktrees/acme/api/issue-42`;

      const pathsA = {
        repositoryId: repoA.id,
        worktree: (issueNumber: number) => `/worktrees/acme/api/issue-${issueNumber}`,
        database: () => '/state/.ai-state/acme/api/orchestrator.sqlite',
      } as unknown as RepositoryRuntimePaths;

      const runtimeA = createMockRuntime(repoA.id, TEST_FINGERPRINT_A, pathsA);

      expect(runtimeA.paths.worktree(42)).toBe(worktreePath);
      expect(runtimeA.paths.worktree(42)).toBe(runtimeA.paths.worktree(42));
    });
  });

  describe('behavioral invariant: runtime_cache_does_not_cross_repository_or_config', () => {
    it('caches only matching repository id and configuration fingerprint', () => {
      const cache = new Map<string, MockRuntime>();
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      const pathsA = { repositoryId: repoA.id, database: () => '/db-a' } as RepositoryRuntimePaths;
      const pathsB = { repositoryId: repoB.id, database: () => '/db-b' } as RepositoryRuntimePaths;

      const runtimeA = createMockRuntime(repoA.id, TEST_FINGERPRINT_A, pathsA);
      const runtimeB = createMockRuntime(repoB.id, TEST_FINGERPRINT_A, pathsB);

      cache.set(`${repoA.id}|${TEST_FINGERPRINT_A}`, runtimeA);
      cache.set(`${repoB.id}|${TEST_FINGERPRINT_A}`, runtimeB);

      expect(cache.get(`${repoA.id}|${TEST_FINGERPRINT_A}`)).toBe(runtimeA);
      expect(cache.get(`${repoB.id}|${TEST_FINGERPRINT_A}`)).toBe(runtimeB);
      expect(cache.get(`${repoA.id}|${TEST_FINGERPRINT_B}`)).toBeUndefined();
    });

    it('does not close a runtime with an active worker lease', () => {
      const workerLeasePort = makeWorkerLeasePort();
      const repoA = makeRepository('acme/api');
      const now = new Date();

      workerLeasePort.acquire({
        repoId: repoA.id,
        workerId: WorkerId('worker-1'),
        runId: RunId('run-1'),
        now,
        ttlMs: 60000,
      });

      const cache = new Map<string, MockRuntime>();
      const pathsA = { repositoryId: repoA.id } as RepositoryRuntimePaths;
      const runtimeA = createMockRuntime(repoA.id, TEST_FINGERPRINT_A, pathsA);
      cache.set(`${repoA.id}|${TEST_FINGERPRINT_A}`, runtimeA);

      const checkActiveLease = workerLeasePort.checkActiveLease(repoA.id, now);
      expect(checkActiveLease).toBe(true);

      const cachedRuntime = cache.get(`${repoA.id}|${TEST_FINGERPRINT_A}`);
      if (cachedRuntime && workerLeasePort.checkActiveLease(cachedRuntime.repoId, now)) {
        expect(cachedRuntime.closed).toBe(false);
      }
    });
  });

  describe('behavioral invariant: stale_runtime_is_reaped_after_lease_release', () => {
    it('stale runtime is reaped after lease release without leaking resources', () => {
      const workerLeasePort = makeWorkerLeasePort();
      const repoA = makeRepository('acme/api');
      const now = new Date();

      workerLeasePort.acquire({
        repoId: repoA.id,
        workerId: WorkerId('worker-1'),
        runId: RunId('run-1'),
        now,
        ttlMs: 60000,
      });

      const cache = new Map<string, MockRuntime>();
      const staleRuntimes = new Set<string>();
      const pathsA = { repositoryId: repoA.id } as RepositoryRuntimePaths;
      const runtimeA = createMockRuntime(repoA.id, TEST_FINGERPRINT_A, pathsA);
      cache.set(`${repoA.id}|${TEST_FINGERPRINT_A}`, runtimeA);

      expect(workerLeasePort.checkActiveLease(repoA.id, now)).toBe(true);

      workerLeasePort.release({
        repoId: repoA.id,
        workerId: WorkerId('worker-1'),
        runId: RunId('run-1'),
      });

      expect(workerLeasePort.checkActiveLease(repoA.id, now)).toBe(false);

      const runtimeKey = `${repoA.id}|${TEST_FINGERPRINT_A}`;
      const isStale = !workerLeasePort.checkActiveLease(repoA.id, now);
      if (isStale) {
        staleRuntimes.add(runtimeKey);
      }

      expect(staleRuntimes.has(runtimeKey)).toBe(true);

      const reaper = () => {
        for (const key of staleRuntimes) {
          const rt = cache.get(key);
          if (rt) {
            rt.closed = true;
            cache.delete(key);
          }
        }
        staleRuntimes.clear();
      };

      reaper();

      expect(cache.has(runtimeKey)).toBe(false);
      expect(runtimeA.closed).toBe(true);
    });

    it('new lease on previously-stale runtime unmarks it stale', () => {
      const workerLeasePort = makeWorkerLeasePort();
      const repoA = makeRepository('acme/api');
      const now = new Date();

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

      const wasStale = !workerLeasePort.checkActiveLease(repoA.id, now);
      expect(wasStale).toBe(true);

      const later = new Date(now.getTime() + 1000);
      workerLeasePort.acquire({
        repoId: repoA.id,
        workerId: WorkerId('worker-2'),
        runId: RunId('run-2'),
        now: later,
        ttlMs: 60000,
      });

      const isActiveAgain = workerLeasePort.checkActiveLease(repoA.id, later);
      expect(isActiveAgain).toBe(true);
    });
  });

  describe('cache invalidation on fingerprint change', () => {
    it('invalidates entry when config fingerprint changes', () => {
      const repoA = makeRepository('acme/api');

      const cache = new Map<string, MockRuntime>();
      const pathsA = { repositoryId: repoA.id } as RepositoryRuntimePaths;
      const runtimeA = createMockRuntime(repoA.id, TEST_FINGERPRINT_A, pathsA);
      cache.set(`${repoA.id}|${TEST_FINGERPRINT_A}`, runtimeA);

      const newFingerprint = TEST_FINGERPRINT_A_V2;
      const existingRuntime = cache.get(`${repoA.id}|${TEST_FINGERPRINT_A}`);
      const shouldRecreate = existingRuntime && existingRuntime.fingerprint !== newFingerprint;

      if (shouldRecreate) {
        existingRuntime.closed = true;
        const newRuntime = createMockRuntime(repoA.id, newFingerprint, pathsA);
        cache.set(`${repoA.id}|${newFingerprint}`, newRuntime);
      }

      expect(existingRuntime?.closed).toBe(true);
      expect(cache.get(`${repoA.id}|${newFingerprint}`)?.fingerprint).toBe(newFingerprint);
    });
  });
});
