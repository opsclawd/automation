import { access, constants } from 'node:fs/promises';
import type { Db } from '@ai-sdlc/infrastructure';
import {
  openDatabase,
  applyMigrations,
  RunRepository,
  JobQueueRepository,
  WorkerLeaseRepository,
  WorkerRegistryRepository,
  RepositoryRuntimeMigrator,
} from '@ai-sdlc/infrastructure';
import type { Repository, RepositoryId } from '@ai-sdlc/domain';
import type { LoadedConfig } from '@ai-sdlc/shared';
import type { RepositoryPort } from '@ai-sdlc/application/ports';
import type { WorkerLoopDeps } from '@ai-sdlc/application';
import type { RepositoryRuntimePaths } from './repository-runtime-paths.js';
import type { RepositoryRuntime } from './repository-runtime-factory.js';
import { RepositoryResolutionError } from './repository-runtime-factory.js';

export interface ComposeRepositoryRuntimeInput {
  automationRoot: string;
  stateRoot: string;
  repository: Repository;
  paths: RepositoryRuntimePaths;
  loadedConfig: LoadedConfig;
  controlPlaneDb: Db;
  listEnabledRepositories: () => Array<{ id: RepositoryId; fullName: string }>;
}

export async function composeRepositoryRuntime(
  input: ComposeRepositoryRuntimeInput,
): Promise<RepositoryRuntime> {
  const { repository, paths, loadedConfig, controlPlaneDb, listEnabledRepositories } = input;

  try {
    await access(paths.database(), constants.R_OK);
  } catch {
    throw new RepositoryResolutionError(
      repository.id,
      'unreachable',
      `Cannot read database at ${paths.database()} for repository ${repository.fullName}`,
    );
  }

  const operationalDb = openDatabase(paths.database());

  try {
    applyMigrations(operationalDb);
  } catch (err) {
    operationalDb.close();
    throw new RepositoryResolutionError(
      repository.id,
      'unknown',
      `Failed to apply migrations to ${paths.database()}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const migrator = new RepositoryRuntimeMigrator({
    controlPlaneDb,
    operationalDb,
    listEnabledRepositories,
  });

  const legacyState = migrator.detectLegacyState();
  if (legacyState.hasLegacyEvents) {
    try {
      await migrator.migrateLegacyState(repository.id);
    } catch (err) {
      operationalDb.close();
      if (err instanceof Error && err.name === 'MigrationError') {
        const migrationErr = err as { code?: string };
        if (migrationErr.code === 'ambiguous_ownership') {
          throw new RepositoryResolutionError(
            repository.id,
            'migration_ambiguous',
            `Legacy state ownership is ambiguous for repository ${repository.fullName}: ${err.message}`,
          );
        }
      }
      throw new RepositoryResolutionError(
        repository.id,
        'unknown',
        `Migration failed for repository ${repository.fullName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const runRepository = new RunRepository(
    operationalDb,
    loadedConfig.fingerprint,
    JSON.stringify(loadedConfig.sources),
  );
  const workerLeaseRepository = new WorkerLeaseRepository(operationalDb);
  const jobQueue = new JobQueueRepository(operationalDb, {
    findById: (id: RepositoryId) => {
      if (id === repository.id) return repository;
      return undefined;
    },
    findByFullName: (fullName: string) => {
      if (fullName === repository.fullName) return repository;
      return undefined;
    },
    findByLocalPath: (localBasePath: string) => {
      if (localBasePath === repository.localBasePath) return repository;
      return undefined;
    },
    listAll: () => [repository],
    listEnabled: () => (repository.enabled ? [repository] : []),
  } as RepositoryPort);
  const workerRegistry = new WorkerRegistryRepository(operationalDb);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      operationalDb.close();
    } catch {
      // Best-effort close
    }
  };

  const runtime: RepositoryRuntime = {
    repository,
    paths,
    configFingerprint: loadedConfig.fingerprint,
    defaultBranch: repository.defaultBranch,
    fullName: repository.fullName,
    jobQueue,
    runRepository,
    workerRegistry,
    workerLeaseRepository,
    workerLoopDeps: {
      registry: workerRegistry,
      queue: jobQueue,
      leases: workerLeaseRepository,
      repos: {
        findById: (id: RepositoryId) => (id === repository.id ? repository : undefined),
        findByFullName: (fullName: string) =>
          fullName === repository.fullName ? repository : undefined,
        findByLocalPath: (localBasePath: string) =>
          localBasePath === repository.localBasePath ? repository : undefined,
        listAll: () => [repository],
        listEnabled: () => (repository.enabled ? [repository] : []),
      },
      repoId: repository.id,
    } as unknown as Omit<WorkerLoopDeps, 'recoverableRunIds'>,
    close,
  };

  return runtime;
}
