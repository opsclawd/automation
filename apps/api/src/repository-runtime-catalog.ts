import type { RepositoryId, RunId, Repository } from '@ai-sdlc/domain';
import type { RunRecord, ListRunsFilter } from '@ai-sdlc/application/ports';
import { loadLayeredConfig } from '@ai-sdlc/shared';
import type { LoadedConfig } from '@ai-sdlc/shared';
import {
  RepositoryRuntimeFactory,
  RepositoryRuntime,
  RepositoryResolutionError,
} from './repository-runtime-factory.js';
import type { Db } from '@ai-sdlc/infrastructure';
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
  /**
   * Optional — defaults to a no-op. resolveEnabled() and listRuns() skip any
   * repository whose runtime fails to resolve (so one broken repository
   * doesn't block aggregate reads across the rest); without a logger that
   * skip is completely silent, with no trace of which repository or why.
   */
  logger?: {
    error(message: string, ...args: unknown[]): void;
  };
}

export interface RepositoryRuntimeCatalog {
  resolve(
    repositoryId: RepositoryId,
    options?: { allowDisabled?: boolean },
  ): Promise<RepositoryRuntime>;
  resolveEnabled(): Promise<Array<{ repository: Repository; runtime: RepositoryRuntime }>>;
  findRun(
    runId: RunId,
    repositoryId?: RepositoryId,
  ): Promise<{ runtime: RepositoryRuntime; run: RunRecord } | undefined>;
  listRuns(filter: ListRunsFilter): Promise<{ runs: RunRecord[]; total: number }>;
  close(): Promise<void>;
}

interface RuntimeEntry {
  runtime: RepositoryRuntime;
  loadedConfig: LoadedConfig;
}

export class DefaultRepositoryRuntimeCatalog implements RepositoryRuntimeCatalog {
  private readonly factory: RepositoryRuntimeFactory;
  private readonly cache = new Map<string, RuntimeEntry>();
  private readonly opts: RepositoryRuntimeCatalogOptions;

  constructor(opts: RepositoryRuntimeCatalogOptions) {
    this.opts = opts;
    this.factory = new RepositoryRuntimeFactory({
      stateRoot: opts.stateRoot,
      buildRuntime: async ({ repository, paths, loadedConfig }) => {
        return composeRepositoryRuntime({
          automationRoot: opts.automationRoot,
          stateRoot: opts.stateRoot,
          repository,
          paths,
          loadedConfig,
          controlPlaneDb: opts.controlPlaneDb,
          listEnabledRepositories: () =>
            opts.registry.listEnabled().map((r) => ({ id: r.id, fullName: r.fullName })),
        });
      },
    });
  }

  async resolve(
    repositoryId: RepositoryId,
    options?: { allowDisabled?: boolean },
  ): Promise<RepositoryRuntime> {
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

    const layered = loadLayeredConfig({
      automationRoot: this.opts.automationRoot,
      targetRoot: repo.localBasePath,
    });

    const runtime = await this.factory.getRuntime(
      repo,
      layered,
      options?.allowDisabled !== undefined ? { allowDisabled: options.allowDisabled } : {},
    );
    this.cache.set(String(repo.id), { runtime, loadedConfig: layered });
    return runtime;
  }

  async resolveEnabled(): Promise<Array<{ repository: Repository; runtime: RepositoryRuntime }>> {
    const results: Array<{ repository: Repository; runtime: RepositoryRuntime }> = [];
    const enabledRepos = this.opts.registry.listEnabled();

    await Promise.all(
      enabledRepos.map(async (repo) => {
        try {
          const runtime = await this.resolve(repo.id, { allowDisabled: false });
          results.push({ repository: repo, runtime });
        } catch (err) {
          // Skip repos that fail to resolve — logged so a repository silently
          // dropping out of aggregate reads (e.g. GET /api/runs) is
          // diagnosable instead of just appearing as missing data.
          this.opts.logger?.error(
            `RepositoryRuntimeCatalog.resolveEnabled: failed to resolve runtime for ${repo.id}`,
            err,
          );
        }
      }),
    );

    return results;
  }

  async findRun(
    runId: RunId,
    repositoryId?: RepositoryId,
  ): Promise<{ runtime: RepositoryRuntime; run: RunRecord } | undefined> {
    if (repositoryId) {
      try {
        const runtime = await this.resolve(repositoryId, { allowDisabled: true });
        const run = runtime.runRepository.findByUuid(String(runId));
        if (run) {
          return { runtime, run };
        }
        return undefined;
      } catch {
        return undefined;
      }
    }

    const enabled = await this.resolveEnabled();
    for (const { runtime } of enabled) {
      const run = runtime.runRepository.findByUuid(String(runId));
      if (run) {
        return { runtime, run };
      }
    }

    const allRepos = this.opts.registry.listAll();
    for (const repo of allRepos) {
      const repoIdStr = String(repo.id);
      const existingEntry = this.cache.get(repoIdStr);
      if (existingEntry) {
        const run = existingEntry.runtime.runRepository.findByUuid(String(runId));
        if (run) {
          return { runtime: existingEntry.runtime, run };
        }
      }
    }

    return undefined;
  }

  async listRuns(filter: ListRunsFilter): Promise<{ runs: RunRecord[]; total: number }> {
    if (filter.repositoryId) {
      try {
        const runtime = await this.resolve(filter.repositoryId, { allowDisabled: true });
        return runtime.runRepository.list(filter);
      } catch {
        return { runs: [], total: 0 };
      }
    }

    const allResults: Array<{ runs: RunRecord[]; total: number }> = [];
    const enabled = await this.resolveEnabled();

    for (const { runtime } of enabled) {
      const result = runtime.runRepository.list(filter);
      allResults.push(result);
    }

    const disabledRepos = this.opts.registry.listAll().filter((r) => !r.enabled);
    const disabledResults = await Promise.all(
      disabledRepos.map(async (repo) => {
        try {
          const runtime = await this.resolve(repo.id, { allowDisabled: true });
          return runtime.runRepository.list(filter);
        } catch (err) {
          this.opts.logger?.error(
            `RepositoryRuntimeCatalog.listRuns: failed to resolve disabled repository runtime for ${repo.id}`,
            err,
          );
          return null;
        }
      }),
    );
    for (const result of disabledResults) {
      if (result) {
        allResults.push(result);
      }
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
    for (const entry of this.cache.values()) {
      try {
        entry.runtime.close();
      } catch {
        // Best-effort close
      }
    }
    this.cache.clear();
  }
}
