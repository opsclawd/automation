import type { Repository, RepositoryId } from '@ai-sdlc/domain';

export interface RepositoryPort {
  findById(id: RepositoryId): Repository | undefined;
  findByFullName(fullName: string): Repository | undefined;
  findByLocalPath(localBasePath: string): Repository | undefined;
  listAll(): Repository[];
  listEnabled(): Repository[];
}
