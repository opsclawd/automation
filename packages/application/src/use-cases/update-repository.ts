import {
  RepositoryNotFoundError,
  RepositoryValidationError,
  type Repository,
  type RepositoryId,
} from '@ai-sdlc/domain';
import type { RepositoryRegistryPort, RepositoryPort, RepositoryUpdatePatch } from '../ports.js';

export interface UpdateRepositoryDeps {
  repos: RepositoryPort;
  registry: RepositoryRegistryPort;
  now?: () => Date;
}

export interface UpdateRepositoryInput {
  id: RepositoryId;
  defaultBranch?: string;
  remoteUrl?: string;
  enabled?: boolean;
  configMetadata?: string;
}

export class UpdateRepository {
  constructor(private readonly deps: UpdateRepositoryDeps) {}

  execute(input: UpdateRepositoryInput): Repository {
    const now = this.deps.now?.() ?? new Date();
    const existing = this.deps.repos.findById(input.id);
    if (!existing) throw new RepositoryNotFoundError(input.id);

    const patch: RepositoryUpdatePatch = {};
    if (input.defaultBranch !== undefined && input.defaultBranch !== existing.defaultBranch) {
      if (!input.defaultBranch.trim()) {
        throw new RepositoryValidationError(
          'defaultBranch cannot be empty',
          existing.localBasePath,
        );
      }
      patch.defaultBranch = input.defaultBranch;
    }
    if (input.remoteUrl !== undefined && input.remoteUrl !== existing.remoteUrl) {
      patch.remoteUrl = input.remoteUrl;
    }
    if (input.enabled !== undefined && input.enabled !== existing.enabled) {
      patch.enabled = input.enabled;
    }
    if (input.configMetadata !== undefined && input.configMetadata !== existing.configMetadata) {
      patch.configMetadata = input.configMetadata;
    }
    this.deps.registry.update(input.id, patch, now);
    return this.deps.repos.findById(input.id)!;
  }
}
