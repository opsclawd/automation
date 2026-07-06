import type { Repository, RepositoryId } from '@ai-sdlc/domain';

export interface RepositoryPort {
  findById(id: RepositoryId): Repository | undefined;
  findByFullName(fullName: string): Repository | undefined;
  findByLocalPath(localPath: string): Repository | undefined;
  listEnabled(): Repository[];
}

export interface RepositoryRegistryPort extends RepositoryPort {
  save(repository: Repository): void;
  delete(id: RepositoryId): void;
  listAll(): Repository[];
}
