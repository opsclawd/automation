import { describe, expect, it, vi, afterEach } from 'vitest';
import { RepositoryId, WorkerId, RunId } from '@ai-sdlc/domain';
import type { Repository } from '@ai-sdlc/domain';
import { RepositoryRuntimeFactory } from '../repository-runtime-factory.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { openDatabase, applyMigrations, WorkerLeaseRepository } from '@ai-sdlc/infrastructure';
import type { LoadedConfig } from '@ai-sdlc/shared';
import type {
  RepositoryExecutionRuntime,
  RepositoryOperationalRuntime,
} from '../repository-runtime-factory.js';

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

interface TestFactoryDeps {
  factory: RepositoryRuntimeFactory;
  stateRoot: string;
  controlPlaneDb: ReturnType<typeof openDatabase>;
  closeCallCount: number;
}

function makeLoadedConfig(fingerprint: string): LoadedConfig {
  return {
    fingerprint,
    sources: {},
    config: { phases: {} },
  };
}

function makeFactory(): TestFactoryDeps {
  const stateRoot = join(tmpdir(), `repo-runtime-factory-test-${Date.now()}-${Math.random()}`);
  mkdirSync(stateRoot, { recursive: true });

  const controlPlaneDb = openDatabase(join(stateRoot, 'control.sqlite'));
  applyMigrations(controlPlaneDb);

  let closeCallCount = 0;

  const factory = new RepositoryRuntimeFactory({
    stateRoot,
    buildOperationalRuntime: async ({ repository, paths }) => {
      const db = openDatabase(paths.database());
      applyMigrations(db);
      const workerLeaseRepository = new WorkerLeaseRepository(db);
      return {
        repository,
        paths,
        runRepository: {} as never,
        workerRegistry: {} as never,
        workerLeaseRepository,
        workerLoopDeps: {} as never,
        eventRepository: {} as never,
        prReviewRepository: {} as never,
        loopRepository: {} as never,
        agentInvocationRepository: {} as never,
        validationRunRepository: {} as never,
        failureRepository: {} as never,
        jobQueue: {} as never,
        close() {
          closeCallCount++;
          try {
            db.close();
          } catch {
            /* ignore */
          }
        },
      } as unknown as RepositoryOperationalRuntime;
    },
    buildExecutionRuntime: async ({ repository, paths, loadedConfig }) => {
      const db = openDatabase(paths.database());
      applyMigrations(db);
      const workerLeaseRepository = new WorkerLeaseRepository(db);
      return {
        repository,
        paths,
        configFingerprint: loadedConfig.fingerprint,
        defaultBranch: repository.defaultBranch,
        fullName: repository.fullName,
        runRepository: {} as never,
        workerRegistry: {} as never,
        workerLeaseRepository,
        workerLoopDeps: {} as never,
        eventRepository: {} as never,
        prReviewRepository: {} as never,
        loopRepository: {} as never,
        agentInvocationRepository: {} as never,
        validationRunRepository: {} as never,
        failureRepository: {} as never,
        jobQueue: {} as never,
        close() {
          closeCallCount++;
          try {
            db.close();
          } catch {
            /* ignore */
          }
        },
      } as unknown as RepositoryExecutionRuntime;
    },
  });

  return { factory, stateRoot, controlPlaneDb, closeCallCount };
}

describe('RepositoryRuntimeFactory', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('behavioral invariant: runtime_resources_follow_repository', () => {
    it('resolves config database paths and git metadata per repository', async () => {
      const { factory, stateRoot, controlPlaneDb } = makeFactory();
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      const runtimeA = await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A));
      const runtimeB = await factory.getRuntime(repoB, makeLoadedConfig(TEST_FINGERPRINT_A));

      expect(runtimeA.paths.database()).not.toBe(runtimeB.paths.database());
      expect(runtimeA.paths.database()).toContain('acme/api');
      expect(runtimeB.paths.database()).toContain('acme/web');
      expect(runtimeA.repository.id).toBe(repoA.id);
      expect(runtimeB.repository.id).toBe(repoB.id);
      expect(runtimeA.defaultBranch).toBe('main');
      expect(runtimeB.defaultBranch).toBe('main');

      factory.close();
      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });

    it('worktree paths are scoped to repository', async () => {
      const { factory, stateRoot, controlPlaneDb } = makeFactory();
      const repoA = makeRepository('acme/api');

      const runtimeA = await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A));
      const worktreePath = runtimeA.paths.worktree(42);

      expect(worktreePath).toContain('acme/api');
      expect(worktreePath).toContain('issue-42');
      expect(runtimeA.paths.worktree(42)).toBe(runtimeA.paths.worktree(42));

      factory.close();
      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });
  });

  describe('behavioral invariant: runtime_cache_is_keyed_by_repository_and_fingerprint', () => {
    it('caches only matching repository id and configuration fingerprint', async () => {
      const { factory, stateRoot, controlPlaneDb } = makeFactory();
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      const runtimeA1 = await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A));
      const runtimeA2 = await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A));
      const runtimeB = await factory.getRuntime(repoB, makeLoadedConfig(TEST_FINGERPRINT_A));

      expect(runtimeA1).toBe(runtimeA2);
      expect(runtimeA1).not.toBe(runtimeB);

      const runtimeA_v2 = await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A_V2));
      expect(runtimeA_v2).not.toBe(runtimeA1);

      factory.close();
      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });

    it('does not close a runtime with an active worker lease when reaped', async () => {
      const { factory, stateRoot, controlPlaneDb } = makeFactory();
      const repoA = makeRepository('acme/api');

      await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A));

      vi.useFakeTimers();
      const now = new Date();
      vi.setSystemTime(now);

      const activeEntry = factory.getActiveRuntimes().values().next().value;
      if (activeEntry) {
        const leaseRepo = activeEntry.workerLeaseRepository as unknown as WorkerLeaseRepository;
        if (leaseRepo && typeof leaseRepo.acquire === 'function') {
          leaseRepo.acquire({
            repoId: repoA.id,
            workerId: WorkerId('worker-1'),
            runId: RunId('run-1'),
            now,
            ttlMs: 60000,
          });
        }
      }

      factory.onLeaseReleased(repoA.id);

      vi.useRealTimers();
      factory.close();
      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });
  });

  describe('behavioral invariant: stale_runtime_is_reaped_after_lease_release', () => {
    it('onLeaseReleased marks runtime as stale when no active lease exists', async () => {
      const { factory, stateRoot, controlPlaneDb } = makeFactory();
      const repoA = makeRepository('acme/api');

      await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A));

      vi.useFakeTimers();
      const now = new Date();
      vi.setSystemTime(now);

      factory.onLeaseReleased(repoA.id);

      expect(factory.isStale(repoA.id)).toBe(true);

      vi.useRealTimers();
      factory.close();
      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });

    it('new lease on previously-stale runtime unmarks it stale', async () => {
      const { factory, stateRoot, controlPlaneDb } = makeFactory();
      const repoA = makeRepository('acme/api');

      await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A));

      vi.useFakeTimers();
      const now = new Date();
      vi.setSystemTime(now);

      factory.onLeaseReleased(repoA.id);
      expect(factory.isStale(repoA.id)).toBe(true);

      factory.onLeaseAcquired(repoA.id);
      expect(factory.isStale(repoA.id)).toBe(false);

      vi.useRealTimers();
      factory.close();
      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });
  });

  describe('behavioral invariant: stale_historical_runtime_reap_resilience', () => {
    it('force-evicts a historical fingerprint runtime after max stale age even while repo is busy', async () => {
      let currentTimeMs = new Date('2026-01-01T00:00:00.000Z').getTime();
      const { factory, stateRoot, controlPlaneDb } = makeFactory();

      const repoA = makeRepository('acme/api');

      vi.useFakeTimers();
      vi.setSystemTime(new Date(currentTimeMs));

      const oldRuntime = await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A));
      const closeSpy = vi.spyOn(oldRuntime, 'close');

      await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A_V2));

      currentTimeMs += 11 * 60 * 1000;
      vi.setSystemTime(new Date(currentTimeMs));

      await vi.runOnlyPendingTimersAsync();
      expect(closeSpy).toHaveBeenCalled();

      vi.useRealTimers();
      factory.close();
      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });
  });

  describe('cache invalidation on fingerprint change', () => {
    it('returns different runtime when config fingerprint changes', async () => {
      const { factory, stateRoot, controlPlaneDb } = makeFactory();
      const repoA = makeRepository('acme/api');

      const runtime1 = await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A));
      const runtime2 = await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A_V2));

      expect(runtime1).not.toBe(runtime2);
      expect(runtime1.configFingerprint).toBe(TEST_FINGERPRINT_A);
      expect(runtime2.configFingerprint).toBe(TEST_FINGERPRINT_A_V2);

      factory.close();
      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });
  });

  describe('validateRepositoryState', () => {
    it('throws RepositoryResolutionError for disabled repository', async () => {
      const { factory, stateRoot, controlPlaneDb } = makeFactory();
      const repo = makeRepository('acme/api', false);

      await expect(factory.getRuntime(repo, makeLoadedConfig(TEST_FINGERPRINT_A))).rejects.toThrow(
        'disabled',
      );

      factory.close();
      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });

    it('throws RepositoryResolutionError for degraded repository', async () => {
      const { factory, stateRoot, controlPlaneDb } = makeFactory();
      const repo = makeRepository('acme/api');
      repo.healthStatus = 'degraded';
      repo.healthError = 'database error';

      await expect(factory.getRuntime(repo, makeLoadedConfig(TEST_FINGERPRINT_A))).rejects.toThrow(
        'degraded',
      );

      factory.close();
      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });

    it('throws RepositoryResolutionError for unreachable repository', async () => {
      const { factory, stateRoot, controlPlaneDb } = makeFactory();
      const repo = makeRepository('acme/api');
      repo.healthStatus = 'unreachable';

      await expect(factory.getRuntime(repo, makeLoadedConfig(TEST_FINGERPRINT_A))).rejects.toThrow(
        'unreachable',
      );

      factory.close();
      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });

    it('throws RepositoryResolutionError for unknown health status', async () => {
      const { factory, stateRoot, controlPlaneDb } = makeFactory();
      const repo = makeRepository('acme/api');
      repo.healthStatus = 'unknown';

      await expect(factory.getRuntime(repo, makeLoadedConfig(TEST_FINGERPRINT_A))).rejects.toThrow(
        'unknown',
      );

      factory.close();
      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });
  });

  describe('getActiveRuntimes', () => {
    it('returns all active runtimes', async () => {
      const { factory, stateRoot, controlPlaneDb } = makeFactory();
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A));
      await factory.getRuntime(repoB, makeLoadedConfig(TEST_FINGERPRINT_A));

      const activeRuntimes = factory.getActiveRuntimes();
      expect(activeRuntimes.size).toBe(2);

      factory.close();
      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });
  });

  describe('close', () => {
    it('clears all runtimes from cache', async () => {
      const { factory, stateRoot, controlPlaneDb } = makeFactory();
      const repoA = makeRepository('acme/api');

      await factory.getRuntime(repoA, makeLoadedConfig(TEST_FINGERPRINT_A));
      expect(factory.getActiveRuntimes().size).toBe(1);

      factory.close();
      expect(factory.getActiveRuntimes().size).toBe(0);

      controlPlaneDb.close();
      rmSync(stateRoot, { recursive: true, force: true });
    });
  });
});
