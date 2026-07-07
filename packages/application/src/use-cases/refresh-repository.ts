import {
  RepositoryNotFoundError,
  RepositoryValidationError,
  recordHealthCheck,
  type Repository,
} from '@ai-sdlc/domain';
import type { RepositoryRegistryPort, RepositoryPort } from '../ports.js';

export interface RepositoryMetadata {
  rootPath: string;
  nameWithOwner: string;
  defaultBranch: string;
  remoteUrl: string;
}

export interface RefreshRepositoryDeps {
  registry: RepositoryRegistryPort;
  repos: RepositoryPort;
  metadataResolver: { resolve(path: string): RepositoryMetadata };
  now?: () => Date;
}

export class RefreshRepository {
  constructor(private readonly deps: RefreshRepositoryDeps) {}

  execute(repositoryId: Repository['id']): Repository {
    const now = this.deps.now?.() ?? new Date();
    const existing = this.deps.repos.findById(repositoryId);
    if (!existing) throw new RepositoryNotFoundError(repositoryId);

    let metadata: RepositoryMetadata;
    try {
      metadata = this.deps.metadataResolver.resolve(existing.localBasePath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const degraded = recordHealthCheck(existing, 'unreachable', message, now);
      this.deps.registry.update(
        repositoryId,
        {
          healthStatus: degraded.healthStatus,
          healthError: degraded.healthError,
          lastHealthCheckAt: degraded.lastHealthCheckAt,
        },
        now,
      );
      throw new RepositoryValidationError(message, existing.localBasePath);
    }

    const refreshed: Repository = {
      ...existing,
      defaultBranch: metadata.defaultBranch,
      remoteUrl: metadata.remoteUrl,
      healthStatus: 'healthy',
      healthError: null,
      lastHealthCheckAt: now,
      updatedAt: now,
    };
    this.deps.registry.update(
      repositoryId,
      {
        defaultBranch: refreshed.defaultBranch,
        remoteUrl: refreshed.remoteUrl,
        healthStatus: refreshed.healthStatus,
        healthError: refreshed.healthError,
        lastHealthCheckAt: refreshed.lastHealthCheckAt,
      },
      now,
    );
    return refreshed;
  }
}
