import { RepositoryNotFoundError, type Repository } from '@ai-sdlc/domain';
import type { RepositoryId } from '@ai-sdlc/domain';
import type { RepositoryPort } from '../ports.js';

export interface InspectRepositoryDeps {
  repos: RepositoryPort;
}

export class InspectRepository {
  constructor(private readonly deps: InspectRepositoryDeps) {}
  executeById(id: RepositoryId): Repository {
    const found = this.deps.repos.findById(id);
    if (!found) throw new RepositoryNotFoundError(id);
    return found;
  }
  executeByFullName(fullName: string): Repository {
    const found = this.deps.repos.findByFullName(fullName);
    if (!found) throw new RepositoryNotFoundError(fullName);
    return found;
  }
  executeByLocalPath(localPath: string): Repository {
    const found = this.deps.repos.findByLocalPath(localPath);
    if (!found) throw new RepositoryNotFoundError(localPath);
    return found;
  }
}
