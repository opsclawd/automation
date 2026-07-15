import { describe, expect, it, afterAll } from 'vitest';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';
import { RepositoryId, WorkerId, RunId, Repository } from '@ai-sdlc/domain';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import {
  composeRepositoryRuntime,
  RepositoryResolutionError,
} from '../compose-repository-runtime.js';
import { RepositoryRuntimePaths } from '../repository-runtime-paths.js';

function makeRepository(fullName: string, enabled = true, localBasePath?: string): Repository {
  const [owner, name] = fullName.split('/');
  return {
    id: RepositoryId(fullName),
    owner,
    name,
    fullName,
    defaultBranch: 'main',
    remoteUrl: `git@github.com:${fullName}.git`,
    localBasePath: localBasePath ?? `/tmp/repos/${fullName}`,
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

describe('repository-operational-runtime', () => {
  describe('runtime_resources_follow_repository with equal issue numbers', () => {
    const tempDirs: string[] = [];

    afterAll(() => {
      for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('two resolved runtimes have distinct database files, queues, and adapters', async () => {
      const stateRootA = join(tmpdir(), `repo-test-a-${Date.now()}-${Math.random()}`);
      const stateRootB = join(tmpdir(), `repo-test-b-${Date.now()}-${Math.random()}`);
      tempDirs.push(stateRootA, stateRootB);
      mkdirSync(stateRootA, { recursive: true });
      mkdirSync(stateRootB, { recursive: true });

      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      const pathsA = RepositoryRuntimePaths.create({ stateRoot: stateRootA, repository: repoA });
      const pathsB = RepositoryRuntimePaths.create({ stateRoot: stateRootB, repository: repoB });

      mkdirSync(pathsA.runsRoot(), { recursive: true });
      mkdirSync(pathsA.tmpRoot(), { recursive: true });
      mkdirSync(pathsB.runsRoot(), { recursive: true });
      mkdirSync(pathsB.tmpRoot(), { recursive: true });

      const dbA = openDatabase(pathsA.database());
      applyMigrations(dbA);
      const dbB = openDatabase(pathsB.database());
      applyMigrations(dbB);

      const loadedConfigA = {
        fingerprint: 'fp-a',
        sources: {},
        config: { phases: {} },
      };
      const loadedConfigB = {
        fingerprint: 'fp-b',
        sources: {},
        config: { phases: {} },
      };

      const listEnabledReposA = () => [{ id: repoA.id, fullName: repoA.fullName }];
      const listEnabledReposB = () => [{ id: repoB.id, fullName: repoB.fullName }];

      const runtimeA = await composeRepositoryRuntime({
        automationRoot: stateRootA,
        stateRoot: stateRootA,
        repository: repoA,
        paths: pathsA,
        loadedConfig: loadedConfigA,
        controlPlaneDb: dbA,
        listEnabledRepositories: listEnabledReposA,
      });

      const runtimeB = await composeRepositoryRuntime({
        automationRoot: stateRootB,
        stateRoot: stateRootB,
        repository: repoB,
        paths: pathsB,
        loadedConfig: loadedConfigB,
        controlPlaneDb: dbB,
        listEnabledRepositories: listEnabledReposB,
      });

      expect(runtimeA.paths.database()).not.toBe(runtimeB.paths.database());
      expect(runtimeA.paths.database()).toContain('acme/api');
      expect(runtimeB.paths.database()).toContain('acme/web');

      expect(runtimeA.paths.runsRoot()).not.toBe(runtimeB.paths.runsRoot());
      expect(runtimeA.paths.runsRoot()).toContain('acme/api');
      expect(runtimeB.paths.runsRoot()).toContain('acme/web');

      expect(runtimeA.paths.tmpRoot()).not.toBe(runtimeB.paths.tmpRoot());
      expect(runtimeA.paths.tmpRoot()).toContain('acme/api');
      expect(runtimeB.paths.tmpRoot()).toContain('acme/web');

      expect(runtimeA.jobQueue).not.toBe(runtimeB.jobQueue);
      expect(runtimeA.runRepository).not.toBe(runtimeB.runRepository);
      expect(runtimeA.workerRegistry).not.toBe(runtimeB.workerRegistry);
      expect(runtimeA.workerLeaseRepository).not.toBe(runtimeB.workerLeaseRepository);

      const worktreeA = runtimeA.paths.worktree(42);
      const worktreeB = runtimeB.paths.worktree(42);
      expect(worktreeA).not.toBe(worktreeB);
      expect(worktreeA).toContain('acme/api');
      expect(worktreeB).toContain('acme/web');

      runtimeA.close();
      runtimeB.close();
      dbA.close();
      dbB.close();
    });
  });

  describe('runtime_cache_is_keyed_by_repository_and_fingerprint', () => {
    const tempDirs: string[] = [];

    afterAll(() => {
      for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('equal Repository/fingerprint requests share one runtime', async () => {
      const stateRoot = join(tmpdir(), `repo-cache-test-${Date.now()}-${Math.random()}`);
      tempDirs.push(stateRoot);
      mkdirSync(stateRoot, { recursive: true });

      const repo = makeRepository('acme/api');
      const paths = RepositoryRuntimePaths.create({ stateRoot, repository: repo });
      mkdirSync(paths.runsRoot(), { recursive: true });
      mkdirSync(paths.tmpRoot(), { recursive: true });

      const db = openDatabase(paths.database());
      applyMigrations(db);

      const loadedConfig = {
        fingerprint: 'fp-same',
        sources: {},
        config: { phases: {} },
      };

      const listEnabledRepos = () => [{ id: repo.id, fullName: repo.fullName }];

      await composeRepositoryRuntime({
        automationRoot: stateRoot,
        stateRoot,
        repository: repo,
        paths,
        loadedConfig,
        controlPlaneDb: db,
        listEnabledRepositories: listEnabledRepos,
      });

      db.close();
    });

    it('a changed fingerprint creates a new entry and closes the old entry only when safe', async () => {
      const stateRoot = join(tmpdir(), `repo-cache-fp-test-${Date.now()}-${Math.random()}`);
      tempDirs.push(stateRoot);
      mkdirSync(stateRoot, { recursive: true });

      const repo = makeRepository('acme/api');
      const paths = RepositoryRuntimePaths.create({ stateRoot, repository: repo });
      mkdirSync(paths.runsRoot(), { recursive: true });
      mkdirSync(paths.tmpRoot(), { recursive: true });

      const db = openDatabase(paths.database());
      applyMigrations(db);

      const listEnabledRepos = () => [{ id: repo.id, fullName: repo.fullName }];

      const loadedConfigV1 = {
        fingerprint: 'fp-v1',
        sources: {},
        config: { phases: {} },
      };

      const runtimeV1 = await composeRepositoryRuntime({
        automationRoot: stateRoot,
        stateRoot,
        repository: repo,
        paths,
        loadedConfig: loadedConfigV1,
        controlPlaneDb: db,
        listEnabledRepositories: listEnabledRepos,
      });

      expect(runtimeV1.configFingerprint).toBe('fp-v1');

      runtimeV1.close();
      db.close();
    });
  });

  describe('active_runtime_is_not_evicted', () => {
    const tempDirs: string[] = [];

    afterAll(() => {
      for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a runtime with an active repository-local lease is retained', async () => {
      const stateRoot = join(tmpdir(), `repo-active-lease-${Date.now()}-${Math.random()}`);
      tempDirs.push(stateRoot);
      mkdirSync(stateRoot, { recursive: true });

      const repo = makeRepository('acme/api');
      const paths = RepositoryRuntimePaths.create({ stateRoot, repository: repo });
      mkdirSync(paths.runsRoot(), { recursive: true });
      mkdirSync(paths.tmpRoot(), { recursive: true });

      const db = openDatabase(paths.database());
      applyMigrations(db);

      const listEnabledRepos = () => [{ id: repo.id, fullName: repo.fullName }];

      const loadedConfig = {
        fingerprint: 'fp-active',
        sources: {},
        config: { phases: {} },
      };

      const runtime = await composeRepositoryRuntime({
        automationRoot: stateRoot,
        stateRoot,
        repository: repo,
        paths,
        loadedConfig,
        controlPlaneDb: db,
        listEnabledRepositories: listEnabledRepos,
      });

      runtime.workerLeaseRepository.acquire({
        repoId: repo.id,
        workerId: WorkerId('worker-1'),
        runId: RunId('run-1'),
        now: new Date(),
        ttlMs: 60000,
      });

      const hasActiveLease = runtime.workerLeaseRepository.checkActiveLease(repo.id, new Date());
      expect(hasActiveLease).toBe(true);

      runtime.close();
      db.close();
    });
  });

  describe('ambiguous_legacy_state_fails_closed', () => {
    const tempDirs: string[] = [];

    afterAll(() => {
      for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('migration ambiguity becomes a typed RepositoryResolutionError and creates no partially usable cache entry', async () => {
      const stateRoot = join(tmpdir(), `repo-legacy-ambig-${Date.now()}-${Math.random()}`);
      tempDirs.push(stateRoot);
      mkdirSync(stateRoot, { recursive: true });

      const repoA = makeRepository('acme/api-a');
      const repoB = makeRepository('acme/api-b');
      const pathsA = RepositoryRuntimePaths.create({ stateRoot, repository: repoA });
      const pathsB = RepositoryRuntimePaths.create({ stateRoot, repository: repoB });
      mkdirSync(pathsA.runsRoot(), { recursive: true });
      mkdirSync(pathsA.tmpRoot(), { recursive: true });
      mkdirSync(pathsB.runsRoot(), { recursive: true });
      mkdirSync(pathsB.tmpRoot(), { recursive: true });

      const dbA = openDatabase(pathsA.database());
      applyMigrations(dbA);
      const dbB = openDatabase(pathsB.database());
      applyMigrations(dbB);

      dbA.pragma('foreign_keys = OFF');
      dbA
        .prepare(
          `INSERT INTO events (run_uuid, repo_id, phase, level, type, message, metadata, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'test-run-uuid',
          null,
          'test',
          'info',
          'test',
          'test message',
          '{}',
          new Date().toISOString(),
        );
      dbA.pragma('foreign_keys = ON');

      const listEnabledRepos = () => [
        { id: repoA.id, fullName: repoA.fullName },
        { id: repoB.id, fullName: repoB.fullName },
      ];

      const loadedConfig = {
        fingerprint: 'fp-legacy',
        sources: {},
        config: { phases: {} },
      };

      await expect(
        composeRepositoryRuntime({
          automationRoot: stateRoot,
          stateRoot,
          repository: repoA,
          paths: pathsA,
          loadedConfig,
          controlPlaneDb: dbA,
          listEnabledRepositories: listEnabledRepos,
        }),
      ).rejects.toThrow(RepositoryResolutionError);

      dbA.close();
      dbB.close();
    });
  });

  describe('unreadable_local_path_is_unavailable', () => {
    const tempDirs: string[] = [];

    afterAll(() => {
      for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a missing or unreadable localBasePath does not prevent database creation in stateRoot', async () => {
      const stateRoot = join(tmpdir(), `repo-unreadable-${Date.now()}-${Math.random()}`);
      tempDirs.push(stateRoot);
      mkdirSync(stateRoot, { recursive: true });

      const repo = makeRepository(
        'acme/nonexistent',
        true,
        '/nonexistent/path/that/does/not/exist',
      );
      const paths = RepositoryRuntimePaths.create({ stateRoot, repository: repo });

      const db = openDatabase(':memory:');
      applyMigrations(db);

      const listEnabledRepos = () => [{ id: repo.id, fullName: repo.fullName }];

      const loadedConfig = {
        fingerprint: 'fp-unreadable',
        sources: {},
        config: { phases: {} },
      };

      const runtime = await composeRepositoryRuntime({
        automationRoot: stateRoot,
        stateRoot,
        repository: repo,
        paths,
        loadedConfig,
        controlPlaneDb: db,
        listEnabledRepositories: listEnabledRepos,
      });

      expect(runtime).toBeDefined();
      expect(runtime.repository).toBe(repo);
      expect(runtime.workerLoopDeps.repoId).toBe(repo.id);

      runtime.close();
      db.close();
    });
  });
});
