import { RepositoryNotFoundError, type RepositoryId } from '@ai-sdlc/domain';
import type { RepositoryPort, RepositoryRegistryPort } from '../ports.js';

export interface RemoveRepositoryDeps {
  repos: RepositoryPort;
  registry: RepositoryRegistryPort;
}

export class RemoveRepository {
  constructor(private readonly deps: RemoveRepositoryDeps) {}
  execute(id: RepositoryId): void {
    const existing = this.deps.repos.findById(id);
    if (!existing) throw new RepositoryNotFoundError(id);
    this.deps.registry.remove(id);
  }
}
