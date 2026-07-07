import { createHash } from 'node:crypto';
import { RepositoryValidationError, type Repository } from '@ai-sdlc/domain';
import type { RepositoryRegistryPort, RepositoryPort } from '../ports.js';

interface RepositoryMetadata {
  rootPath: string;
  nameWithOwner: string;
  defaultBranch: string;
  remoteUrl: string;
}

export interface RegisterRepositoryDeps {
  registry: RepositoryRegistryPort;
  repos: RepositoryPort;
  metadataResolver: { resolve(path: string): RepositoryMetadata };
  now?: () => Date;
}

export interface RegisterRepositoryInput {
  localPath: string;
  fullName?: string;
  configMetadata?: string;
}

export class RegisterRepository {
  constructor(private readonly deps: RegisterRepositoryDeps) {}

  execute(input: RegisterRepositoryInput): Repository {
    const now = this.deps.now?.() ?? new Date();
    let metadata: RepositoryMetadata;
    try {
      metadata = this.deps.metadataResolver.resolve(input.localPath);
    } catch (err) {
      throw new RepositoryValidationError(
        err instanceof Error ? err.message : String(err),
        input.localPath,
      );
    }

    const [owner, name] = metadata.nameWithOwner.split('/');
    if (!owner || !name) {
      throw new RepositoryValidationError(
        `nameWithOwner "${metadata.nameWithOwner}" is not in owner/name form`,
        metadata.rootPath,
      );
    }

    if (this.deps.repos.findByFullName(metadata.nameWithOwner)) {
      throw new RepositoryValidationError(
        `Repository ${metadata.nameWithOwner} is already registered`,
        metadata.rootPath,
      );
    }
    if (this.deps.repos.findByLocalPath(metadata.rootPath)) {
      throw new RepositoryValidationError(
        `Local path ${metadata.rootPath} is already registered`,
        metadata.rootPath,
      );
    }

    const repo: Repository = {
      id: createHash('sha256').update(metadata.nameWithOwner).digest('hex') as Repository['id'],
      owner,
      name,
      fullName: metadata.nameWithOwner,
      defaultBranch: metadata.defaultBranch,
      remoteUrl: metadata.remoteUrl,
      localBasePath: metadata.rootPath,
      enabled: true,
      maxConcurrentRuns: 1,
      healthStatus: 'healthy',
      healthError: null,
      lastHealthCheckAt: now,
      configMetadata: input.configMetadata ?? '{}',
      createdAt: now,
      updatedAt: now,
    };

    this.deps.registry.insert(repo);
    return repo;
  }
}
