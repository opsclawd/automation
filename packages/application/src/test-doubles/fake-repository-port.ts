import type { Repository, RepositoryId } from '@ai-sdlc/domain';
import type { RepositoryPort } from '../ports.js';

export class FakeRepositoryPort implements RepositoryPort {
  private byId = new Map<RepositoryId, Repository>();
  private byPath = new Map<string, Repository>();
  constructor(seed: Repository[] = []) {
    for (const r of seed) {
      this.byId.set(r.id, r);
      this.byPath.set(r.localBasePath, r);
    }
  }
  findById(id: RepositoryId): Repository | undefined {
    return this.byId.get(id);
  }
  findByFullName(fullName: string): Repository | undefined {
    for (const r of this.byId.values()) if (r.fullName === fullName) return r;
    return undefined;
  }
  findByLocalPath(localBasePath: string): Repository | undefined {
    return this.byPath.get(localBasePath);
  }
  listAll(): Repository[] {
    return [...this.byId.values()];
  }
  listEnabled(): Repository[] {
    return [...this.byId.values()].filter((r) => r.enabled);
  }
}
