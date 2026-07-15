import type { RepositoryId, RunId, Repository } from '@ai-sdlc/domain';
import type { RunRecord, ListRunsFilter } from '@ai-sdlc/application/ports';
import { loadLayeredConfig } from '@ai-sdlc/shared';
import { stat } from 'node:fs/promises';
import {
  RepositoryRuntimeFactory,
  RepositoryExecutionRuntime,
  RepositoryOperationalRuntime,
  RepositoryResolutionError,
} from './repository-runtime-factory.js';
import type { Db } from '@ai-sdlc/infrastructure';
import { composeRepositoryOperationalRuntime } from './compose-repository-operational-runtime.js';
import { composeRepositoryRuntime } from './compose-repository-runtime.js';

export interface RepositoryRuntimeCatalogOptions {
  automationRoot: string;
  stateRoot: string;
  controlPlaneDb: Db;
  registry: {
    findById(id: RepositoryId): Repository | undefined;
    findByFullName(fullName: string): Repository | undefined;
    findByLocalPath(localBasePath: string): Repository | undefined;
    listAll(): Array<Repository>;
    listEnabled(): Array<Repository>;
  };
  logger?: {
    error(message: string, ...args: unknown[]): void;
  };
}

export interface RepositoryOperationalResolution {
  repository: Repository;
  runtime?: RepositoryOperationalRuntime;
  error?: RepositoryResolutionError;
}

export interface RepositoryRuntimeCatalog {
  resolveOperational(repositoryId: RepositoryId): Promise<RepositoryOperationalRuntime>;
  resolve(
    repositoryId: RepositoryId,
    options?: { allowDisabled?: boolean },
  ): Promise<RepositoryExecutionRuntime>;
  resolveExecution(
    repositoryId: RepositoryId,
    options?: { allowDisabled?: boolean },
  ): Promise<RepositoryExecutionRuntime>;
  resolveAllOperational(): Promise<RepositoryOperationalResolution[]>;
  findRun(
    runId: RunId,
    repositoryId?: RepositoryId,
  ): Promise<{ runtime: RepositoryExecutionRuntime; run: RunRecord } | undefined>;
  listRuns(filter: ListRunsFilter): Promise<{ runs: RunRecord[]; total: number }>;
  close(): Promise<void>;
}

export class DefaultRepositoryRuntimeCatalog implements RepositoryRuntimeCatalog {
  private readonly factory: RepositoryRuntimeFactory;
  private readonly opts: RepositoryRuntimeCatalogOptions;

  constructor(opts: RepositoryRuntimeCatalogOptions) {
    this.opts = opts;
    this.factory = new RepositoryRuntimeFactory({
      stateRoot: opts.stateRoot,
      buildOperationalRuntime: async ({ repository, paths }) => {
        return composeRepositoryOperationalRuntime({
          automationRoot: opts.automationRoot,
          stateRoot: opts.stateRoot,
          repository,
          paths,
          controlPlaneDb: opts.controlPlaneDb,
          listEnabledRepositories: () =>
            opts.registry.listEnabled().map((r) => ({ id: r.id, fullName: r.fullName })),
        });
      },
      buildExecutionRuntime: async ({ repository, paths, loadedConfig, operationalRuntime }) => {
        return composeRepositoryRuntime({
          automationRoot: opts.automationRoot,
          stateRoot: opts.stateRoot,
          repository,
          paths,
          loadedConfig,
          controlPlaneDb: opts.controlPlaneDb,
          listEnabledRepositories: () =>
            opts.registry.listEnabled().map((r) => ({ id: r.id, fullName: r.fullName })),
          ...(operationalRuntime ? { operationalRuntime } : {}),
        });
      },
    });
  }

  async resolveOperational(repositoryId: RepositoryId): Promise<RepositoryOperationalRuntime> {
    const repo = this.opts.registry.findById(repositoryId);
    if (!repo) {
      throw new RepositoryResolutionError(
        repositoryId,
        'unknown',
        `Repository ${repositoryId} not found`,
      );
    }

    return await this.factory.getOperationalRuntime(repo);
  }

  resolve = this.resolveExecution;

  async resolveExecution(
    repositoryId: RepositoryId,
    options?: { allowDisabled?: boolean },
  ): Promise<RepositoryExecutionRuntime> {
    const repo = this.opts.registry.findById(repositoryId);
    if (!repo) {
      throw new RepositoryResolutionError(
        repositoryId,
        'unknown',
        `Repository ${repositoryId} not found`,
      );
    }

    if (!options?.allowDisabled && !repo.enabled) {
      throw new RepositoryResolutionError(
        repo.id,
        'disabled',
        `Repository ${repo.fullName} is disabled`,
      );
    }

    if (repo.healthStatus === 'degraded') {
      throw new RepositoryResolutionError(
        repo.id,
        'degraded',
        `Repository ${repo.fullName} is in degraded health state`,
      );
    }

    if (repo.healthStatus === 'unreachable') {
      throw new RepositoryResolutionError(
        repo.id,
        'unreachable',
        `Repository ${repo.fullName} is unreachable`,
      );
    }

    if (repo.healthStatus === 'unknown') {
      throw new RepositoryResolutionError(
        repo.id,
        'unknown',
        `Repository ${repo.fullName} has unknown health status: ${repo.healthError ?? 'unknown'}`,
      );
    }

    try {
      await stat(repo.localBasePath);
    } catch {
      throw new RepositoryResolutionError(
        repo.id,
        'unreachable',
        `Repository ${repo.fullName} checkout is not available at ${repo.localBasePath}`,
      );
    }

    const layered = loadLayeredConfig({
      automationRoot: this.opts.automationRoot,
      targetRoot: repo.localBasePath,
    });

    const runtime = await this.factory.getRuntime(
      repo,
      layered,
      options?.allowDisabled !== undefined ? { allowDisabled: options.allowDisabled } : {},
    );
    return runtime;
  }

  async resolveAllOperational(): Promise<RepositoryOperationalResolution[]> {
    const allRepos = this.opts.registry.listAll();
    const results: RepositoryOperationalResolution[] = [];

    await Promise.all(
      allRepos.map(async (repo) => {
        try {
          const runtime = await this.resolveOperational(repo.id);
          results.push({ repository: repo, runtime });
        } catch (err) {
          if (err instanceof RepositoryResolutionError) {
            results.push({ repository: repo, error: err });
          } else {
            results.push({
              repository: repo,
              error: new RepositoryResolutionError(
                repo.id,
                'unknown',
                `Failed to resolve operational runtime: ${err instanceof Error ? err.message : String(err)}`,
              ),
            });
          }
        }
      }),
    );

    return results;
  }

  async findRun(
    runId: RunId,
    repositoryId?: RepositoryId,
  ): Promise<{ runtime: RepositoryExecutionRuntime; run: RunRecord } | undefined> {
    if (repositoryId) {
      try {
        const runtime = await this.resolveExecution(repositoryId, { allowDisabled: true });
        const run = runtime.runRepository.findByUuid(String(runId));
        if (run) {
          return { runtime, run };
        }
        return undefined;
      } catch {
        return undefined;
      }
    }

    const allOperational = await this.resolveAllOperational();
    for (const { runtime } of allOperational) {
      if (!runtime) continue;
      const run = runtime.runRepository.findByUuid(String(runId));
      if (run) {
        const executionRuntime = await this.resolveExecution(runtime.repository.id, {
          allowDisabled: true,
        });
        return { runtime: executionRuntime, run };
      }
    }

    return undefined;
  }

  async resolveEnabled(): Promise<
    Array<{ repository: Repository; runtime: RepositoryExecutionRuntime }>
  > {
    const results: Array<{ repository: Repository; runtime: RepositoryExecutionRuntime }> = [];
    const enabledRepos = this.opts.registry.listEnabled();

    await Promise.all(
      enabledRepos.map(async (repo) => {
        try {
          const runtime = await this.resolveExecution(repo.id, { allowDisabled: false });
          results.push({ repository: repo, runtime });
        } catch (err) {
          this.opts.logger?.error(
            `DefaultRepositoryRuntimeCatalog.resolveEnabled: failed to resolve runtime for ${repo.id}`,
            err,
          );
        }
      }),
    );

    return results;
  }

  async listRuns(filter: ListRunsFilter): Promise<{ runs: RunRecord[]; total: number }> {
    if (filter.repositoryId) {
      try {
        const runtime = await this.resolveExecution(filter.repositoryId, { allowDisabled: true });
        return runtime.runRepository.list(filter);
      } catch (err) {
        this.opts.logger?.error(
          `DefaultRepositoryRuntimeCatalog.listRuns: failed to resolve runtime for explicit repositoryId ${filter.repositoryId}`,
          err,
        );
        return { runs: [], total: 0 };
      }
    }

    const allResults: Array<{ runs: RunRecord[]; total: number }> = [];
    const allOperational = await this.resolveAllOperational();

    for (const { runtime } of allOperational) {
      if (!runtime) continue;
      const result = runtime.runRepository.list(filter);
      allResults.push(result);
    }

    const allRuns: RunRecord[] = [];
    let total = 0;
    for (const result of allResults) {
      allRuns.push(...result.runs);
      total += result.total;
    }

    allRuns.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    const limit = filter.limit ?? 25;
    const offset = filter.offset ?? 0;
    const paginatedRuns = allRuns.slice(offset, offset + limit);

    return { runs: paginatedRuns, total };
  }

  async close(): Promise<void> {
    this.factory.close();
  }
}
