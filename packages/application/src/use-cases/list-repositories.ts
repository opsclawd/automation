import type { Repository } from '@ai-sdlc/domain';
import type { RepositoryPort } from '../ports.js';

export interface ListRepositoriesDeps {
  repos: RepositoryPort;
}

export class ListRepositories {
  constructor(private readonly deps: ListRepositoriesDeps) {}
  execute(opts: { includeDisabled?: boolean } = {}): Repository[] {
    return opts.includeDisabled ? this.deps.repos.listAll() : this.deps.repos.listEnabled();
  }
}
