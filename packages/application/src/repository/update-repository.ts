import {
  type Repository,
  type RepositoryId,
} from '@ai-sdlc/domain';
import type { RepositoryRegistryPort } from '../ports.js';

export interface UpdateRepositoryInput {
  id: RepositoryId;
  localBasePath?: string;
  enabled?: boolean;
  configMetadata?: Record<string, unknown>;
}

export class UpdateRepository {
  constructor(private readonly repos: RepositoryRegistryPort) {}

  async execute(input: UpdateRepositoryInput): Promise<Repository> {
    const repo = this.repos.findById(input.id);
    if (!repo) {
      throw new Error(`Repository not found: ${input.id}`);
    }

    const updatedRepo: Repository = {
      ...repo,
      ...(input.localBasePath !== undefined ? { localBasePath: input.localBasePath } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.configMetadata !== undefined ? { configMetadata: input.configMetadata } : {}),
      updatedAt: new Date(),
    };

    this.repos.save(updatedRepo);
    return updatedRepo;
  }
}
