import { describe, expect, it, afterEach, vi } from 'vitest';
import { RepositoryId } from '@ai-sdlc/domain';
import type { Repository } from '@ai-sdlc/domain';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';
import { DefaultRepositoryRuntimeCatalog } from '../repository-runtime-catalog.js';

function makeRepository(
  fullName: string,
  enabled = true,
  healthStatus: 'healthy' | 'degraded' | 'unreachable' = 'healthy',
): Repository {
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
    healthStatus,
    healthError: null,
    lastHealthCheckAt: null,
    configMetadata: '{}',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('RepositoryOperationalRuntime', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    tempDirs.length = 0;
  });

  describe('behavioral invariant: operational runtime opens when checkout path is missing', () => {
    it('resolves operational runtime even when localBasePath does not exist', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'operational-test-'));
      tempDirs.push(stateRoot);
      mkdirSync(stateRoot, { recursive: true });

      writeFileSync(
        join(stateRoot, '.ai-orchestrator.json'),
        JSON.stringify({
          phases: { skip: [], reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
          validation: { commands: ['echo ok'], timeout: 10 },
          timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        }),
      );

      const controlDb = openDatabase(join(stateRoot, 'control.sqlite'));
      applyMigrations(controlDb);

      const repo = makeRepository('owner/ghost-repo', true);
      repo.localBasePath = '/non/existent/path/that/does/not/exist';

      const registry = {
        findById: () => repo,
        findByFullName: () => repo,
        findByLocalPath: () => repo,
        listAll: () => [repo],
        listEnabled: () => [repo],
      };

      const catalog = new DefaultRepositoryRuntimeCatalog({
        automationRoot: stateRoot,
        stateRoot,
        controlPlaneDb: controlDb,
        registry,
      });

      const runtime = await catalog.resolveOperational(repo.id);
      expect(runtime).toBeDefined();
      expect(runtime.repository.id).toBe(repo.id);
      expect(runtime.paths.database()).toContain('owner/ghost-repo');
      await catalog.close();
      controlDb.close();
    });
  });

  describe('behavioral invariant: operational runtime opens for disabled repository', () => {
    it('resolves operational runtime for disabled repository without config loading', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'operational-test-'));
      tempDirs.push(stateRoot);
      mkdirSync(stateRoot, { recursive: true });

      writeFileSync(
        join(stateRoot, '.ai-orchestrator.json'),
        JSON.stringify({
          phases: { skip: [], reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
          validation: { commands: ['echo ok'], timeout: 10 },
          timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        }),
      );

      const controlDb = openDatabase(join(stateRoot, 'control.sqlite'));
      applyMigrations(controlDb);

      const repo = makeRepository('owner/disabled-repo', false);
      repo.localBasePath = join(stateRoot, 'owner', 'disabled-repo');

      const registry = {
        findById: () => repo,
        findByFullName: () => repo,
        findByLocalPath: () => repo,
        listAll: () => [repo],
        listEnabled: () => [],
      };

      const catalog = new DefaultRepositoryRuntimeCatalog({
        automationRoot: stateRoot,
        stateRoot,
        controlPlaneDb: controlDb,
        registry,
      });

      const runtime = await catalog.resolveOperational(repo.id);
      expect(runtime).toBeDefined();
      expect(runtime.repository.id).toBe(repo.id);
      expect(runtime.repository.enabled).toBe(false);
      await catalog.close();
      controlDb.close();
    });
  });

  describe('behavioral invariant: execution runtime rejects unavailable checkout', () => {
    it('throws when resolving execution runtime for repository with missing checkout', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'execution-test-'));
      tempDirs.push(stateRoot);
      mkdirSync(stateRoot, { recursive: true });

      writeFileSync(
        join(stateRoot, '.ai-orchestrator.json'),
        JSON.stringify({
          phases: { skip: [], reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
          validation: { commands: ['echo ok'], timeout: 10 },
          timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        }),
      );

      const controlDb = openDatabase(join(stateRoot, 'control.sqlite'));
      applyMigrations(controlDb);

      const repo = makeRepository('owner/missing-repo', true);
      repo.localBasePath = '/non/existent/path/that/does/not/exist';

      const registry = {
        findById: () => repo,
        findByFullName: () => repo,
        findByLocalPath: () => repo,
        listAll: () => [repo],
        listEnabled: () => [repo],
      };

      const catalog = new DefaultRepositoryRuntimeCatalog({
        automationRoot: stateRoot,
        stateRoot,
        controlPlaneDb: controlDb,
        registry,
      });

      await expect(catalog.resolveExecution(repo.id)).rejects.toThrow();
      await catalog.close();
      controlDb.close();
    });
  });

  describe('behavioral invariant: all registered repositories receive operational resolution result', () => {
    it('resolveAllOperational returns entry for every repository including failures', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'operational-test-'));
      tempDirs.push(stateRoot);
      mkdirSync(stateRoot, { recursive: true });

      writeFileSync(
        join(stateRoot, '.ai-orchestrator.json'),
        JSON.stringify({
          phases: { skip: [], reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
          validation: { commands: ['echo ok'], timeout: 10 },
          timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        }),
      );

      const controlDb = openDatabase(join(stateRoot, 'control.sqlite'));
      applyMigrations(controlDb);

      const repo1 = makeRepository('owner/repo1', true);
      repo1.localBasePath = join(stateRoot, 'owner', 'repo1');
      const repo2 = makeRepository('owner/repo2', false);
      repo2.localBasePath = '/non/existent/repo2';
      const repo3 = makeRepository('owner/repo3', true);
      repo3.localBasePath = join(stateRoot, 'owner', 'repo3');

      mkdirSync(repo1.localBasePath, { recursive: true });
      mkdirSync(repo3.localBasePath, { recursive: true });

      const registry = {
        findById: (id: RepositoryId) => {
          if (id === repo1.id) return repo1;
          if (id === repo2.id) return repo2;
          if (id === repo3.id) return repo3;
          return undefined;
        },
        findByFullName: () => undefined,
        findByLocalPath: () => undefined,
        listAll: () => [repo1, repo2, repo3],
        listEnabled: () => [repo1, repo3],
      };

      const catalog = new DefaultRepositoryRuntimeCatalog({
        automationRoot: stateRoot,
        stateRoot,
        controlPlaneDb: controlDb,
        registry,
      });

      const results = await catalog.resolveAllOperational();

      expect(results.length).toBe(3);

      const successResults = results.filter((r) => 'runtime' in r);
      const errorResults = results.filter((r) => 'error' in r);

      expect(successResults.length).toBeGreaterThanOrEqual(2);
      expect(errorResults.length).toBeLessThanOrEqual(1);

      const repo1Result = results.find((r) => r.repository.id === repo1.id);
      expect(repo1Result).toBeDefined();
      expect('runtime' in repo1Result!).toBe(true);

      await catalog.close();
      controlDb.close();
    });
  });

  describe('behavioral invariant: operational cache identity does not depend on target config fingerprint', () => {
    it('returns same operational runtime regardless of config fingerprint', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'operational-test-'));
      tempDirs.push(stateRoot);
      mkdirSync(stateRoot, { recursive: true });

      writeFileSync(
        join(stateRoot, '.ai-orchestrator.json'),
        JSON.stringify({
          phases: { skip: [], reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
          validation: { commands: ['echo ok'], timeout: 10 },
          timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        }),
      );

      const repoDir = join(stateRoot, 'owner', 'repo');
      mkdirSync(repoDir, { recursive: true });

      const controlDb = openDatabase(join(stateRoot, 'control.sqlite'));
      applyMigrations(controlDb);

      const repo = makeRepository('owner/repo', true);
      repo.localBasePath = repoDir;

      const registry = {
        findById: () => repo,
        findByFullName: () => repo,
        findByLocalPath: () => repo,
        listAll: () => [repo],
        listEnabled: () => [repo],
      };

      const catalog = new DefaultRepositoryRuntimeCatalog({
        automationRoot: stateRoot,
        stateRoot,
        controlPlaneDb: controlDb,
        registry,
      });

      const operational1 = await catalog.resolveOperational(repo.id);
      const operational2 = await catalog.resolveOperational(repo.id);

      expect(operational1).toBe(operational2);

      await catalog.close();
      controlDb.close();
    });
  });

  describe('behavioral invariant: close rejects a runtime with live ownership', () => {
    it('throws when closing a runtime that still has an active lease', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'operational-test-'));
      tempDirs.push(stateRoot);
      mkdirSync(stateRoot, { recursive: true });

      writeFileSync(
        join(stateRoot, '.ai-orchestrator.json'),
        JSON.stringify({
          phases: { skip: [], reviewFix: { maxIterations: 10 }, implement: { maxIterations: 5 } },
          validation: { commands: ['echo ok'], timeout: 10 },
          timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        }),
      );

      const repoDir = join(stateRoot, 'owner', 'repo');
      mkdirSync(repoDir, { recursive: true });

      const controlDb = openDatabase(join(stateRoot, 'control.sqlite'));
      applyMigrations(controlDb);

      const repo = makeRepository('owner/repo', true);
      repo.localBasePath = repoDir;

      const registry = {
        findById: () => repo,
        findByFullName: () => repo,
        findByLocalPath: () => repo,
        listAll: () => [repo],
        listEnabled: () => [repo],
      };

      const catalog = new DefaultRepositoryRuntimeCatalog({
        automationRoot: stateRoot,
        stateRoot,
        controlPlaneDb: controlDb,
        registry,
      });

      const runtime = await catalog.resolveOperational(repo.id);

      const lease = runtime.workerLeaseRepository.acquire({
        repoId: repo.id,
        workerId: 'worker-1' as never,
        runId: 'run-1' as never,
        now: new Date(),
        ttlMs: 60000,
      });

      expect(() => runtime.close()).toThrow();

      runtime.workerLeaseRepository.release({
        repoId: repo.id,
        workerId: 'worker-1' as never,
        runId: 'run-1' as never,
        leaseToken: lease.leaseToken,
      });

      expect(() => runtime.close()).not.toThrow();

      await catalog.close();
      controlDb.close();
    });
  });
});
