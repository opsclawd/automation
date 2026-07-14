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

describe('DefaultRepositoryRuntimeCatalog', () => {
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

  describe('resolve', () => {
    it('throws RepositoryResolutionError for unknown repository', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'catalog-test-'));
      tempDirs.push(stateRoot);
      const controlDb = openDatabase(join(stateRoot, 'control.sqlite'));
      applyMigrations(controlDb);

      const registry = {
        findById: () => undefined,
        findByFullName: () => undefined,
        findByLocalPath: () => undefined,
        listAll: () => [],
        listEnabled: () => [],
      };

      const catalog = new DefaultRepositoryRuntimeCatalog({
        automationRoot: stateRoot,
        stateRoot,
        controlPlaneDb: controlDb,
        registry,
      });

      await expect(catalog.resolve(RepositoryId('unknown'))).rejects.toThrow('not found');
      await catalog.close();
      controlDb.close();
    });

    it('throws RepositoryResolutionError for disabled repository when allowDisabled is false', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'catalog-test-'));
      tempDirs.push(stateRoot);
      const controlDb = openDatabase(join(stateRoot, 'control.sqlite'));
      applyMigrations(controlDb);

      const repo = makeRepository('owner/disabled-repo', false);
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

      await expect(catalog.resolve(repo.id)).rejects.toThrow('disabled');
      await catalog.close();
      controlDb.close();
    });

    it('throws RepositoryResolutionError for degraded repository', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'catalog-test-'));
      tempDirs.push(stateRoot);
      const controlDb = openDatabase(join(stateRoot, 'control.sqlite'));
      applyMigrations(controlDb);

      const repo = makeRepository('owner/degraded-repo', true, 'degraded');
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

      await expect(catalog.resolve(repo.id)).rejects.toThrow('degraded');
      await catalog.close();
      controlDb.close();
    });

    it('throws RepositoryResolutionError for unreachable repository', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'catalog-test-'));
      tempDirs.push(stateRoot);
      const controlDb = openDatabase(join(stateRoot, 'control.sqlite'));
      applyMigrations(controlDb);

      const repo = makeRepository('owner/unreachable-repo', true, 'unreachable');
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

      await expect(catalog.resolve(repo.id)).rejects.toThrow('unreachable');
      await catalog.close();
      controlDb.close();
    });

    it('allows disabled repository when allowDisabled is true', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'catalog-test-'));
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

      const repoDir = join(stateRoot, 'owner', 'disabled-repo');
      mkdirSync(repoDir, { recursive: true });

      const controlDb = openDatabase(join(stateRoot, 'control.sqlite'));
      applyMigrations(controlDb);

      const repo = makeRepository('owner/disabled-repo', false);
      repo.localBasePath = repoDir;

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

      const runtime = await catalog.resolve(repo.id, { allowDisabled: true });
      expect(runtime).toBeDefined();
      expect(runtime.repository.id).toBe(repo.id);
      await catalog.close();
      controlDb.close();
    });

    it('populates cache after successful resolve', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'catalog-test-'));
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

      const repoDir = join(stateRoot, 'owner', 'enabled-repo');
      mkdirSync(repoDir, { recursive: true });

      const controlDb = openDatabase(join(stateRoot, 'control.sqlite'));
      applyMigrations(controlDb);

      const repo = makeRepository('owner/enabled-repo', true);
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

      const runtime1 = await catalog.resolve(repo.id);
      const runtime2 = await catalog.resolve(repo.id);
      expect(runtime1).toBe(runtime2);
      await catalog.close();
      controlDb.close();
    });
  });

  describe('resolveEnabled', () => {
    it('resolves all enabled repositories', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'catalog-test-'));
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

      const repo1Dir = join(stateRoot, 'owner', 'repo1');
      const repo2Dir = join(stateRoot, 'owner', 'repo2');
      mkdirSync(repo1Dir, { recursive: true });
      mkdirSync(repo2Dir, { recursive: true });

      const controlDb = openDatabase(join(stateRoot, 'control.sqlite'));
      applyMigrations(controlDb);

      const repo1 = makeRepository('owner/repo1', true);
      repo1.localBasePath = repo1Dir;
      const repo2 = makeRepository('owner/repo2', true);
      repo2.localBasePath = repo2Dir;
      const repo3 = makeRepository('owner/repo3', false);
      repo3.localBasePath = join(stateRoot, 'owner', 'repo3');

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
        listEnabled: () => [repo1, repo2],
      };

      const catalog = new DefaultRepositoryRuntimeCatalog({
        automationRoot: stateRoot,
        stateRoot,
        controlPlaneDb: controlDb,
        registry,
      });

      const results = await catalog.resolveEnabled();
      expect(results.length).toBe(2);
      expect(results.some((r) => r.repository.id === repo1.id)).toBe(true);
      expect(results.some((r) => r.repository.id === repo2.id)).toBe(true);
      await catalog.close();
      controlDb.close();
    });
  });

  describe('close', () => {
    it('closes all runtimes without throwing', async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'catalog-test-'));
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

      await catalog.resolve(repo.id);
      await expect(catalog.close()).resolves.not.toThrow();
    });
  });
});
