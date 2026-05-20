import type { Repository, RepositoryId } from '@ai-sdlc/domain';
import type { RepositoryPort } from '../ports.js';

export class FakeRepositoryPort implements RepositoryPort {
  private byId = new Map<RepositoryId, Repository>();
  constructor(seed: Repository[] = []) {
    for (const r of seed) this.byId.set(r.id, r);
  }
  findById(id: RepositoryId): Repository | undefined {
    return this.byId.get(id);
  }
  findByFullName(fullName: string): Repository | undefined {
    for (const r of this.byId.values()) if (r.fullName === fullName) return r;
    return undefined;
  }
  listEnabled(): Repository[] {
    return [...this.byId.values()].filter((r) => r.enabled);
  }
}
