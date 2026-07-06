import {
  type Repository,
  type RepositoryId,
} from '@ai-sdlc/domain';
import type { RepositoryRegistryPort } from '../ports.js';

export class ListRepositories {
  constructor(private readonly repos: RepositoryRegistryPort) {}

  async execute(): Promise<Repository[]> {
    return this.repos.listAll();
  }
}

export class GetRepository {
  constructor(private readonly repos: RepositoryRegistryPort) {}

  async execute(id: RepositoryId): Promise<Repository | undefined> {
    return this.repos.findById(id);
  }
}
