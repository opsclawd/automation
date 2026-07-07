import {
  markRepositoryEnabled,
  RepositoryNotFoundError,
  type Repository,
  type RepositoryId,
} from '@ai-sdlc/domain';
import type { RepositoryPort, RepositoryRegistryPort } from '../ports.js';

export interface EnableRepositoryDeps {
  repos: RepositoryPort;
  registry: RepositoryRegistryPort;
  now?: () => Date;
}

export class EnableRepository {
  constructor(private readonly deps: EnableRepositoryDeps) {}
  execute(id: RepositoryId): Repository {
    const now = this.deps.now?.() ?? new Date();
    const existing = this.deps.repos.findById(id);
    if (!existing) throw new RepositoryNotFoundError(id);
    const next = markRepositoryEnabled(existing, true, now);
    this.deps.registry.update(id, { enabled: next.enabled }, now);
    return next;
  }
}
