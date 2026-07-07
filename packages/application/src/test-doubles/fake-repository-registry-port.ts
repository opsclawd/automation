import type { Repository, RepositoryId } from '@ai-sdlc/domain';
import {
  DuplicateRepositoryError,
  RepositoryHasActiveRunsError,
  RepositoryNotFoundError,
} from '@ai-sdlc/domain';
import type { RepositoryRegistryPort, RepositoryUpdatePatch } from '../ports.js';

export class FakeRepositoryRegistryPort implements RepositoryRegistryPort {
  private byId: Map<RepositoryId, Repository>;
  /** Map repo id → active run count. Seeded by tests via seedActiveRunCount. */
  private activeCounts: Map<RepositoryId, number>;
  constructor(sharedStore?: { byId: Map<RepositoryId, Repository> }) {
    this.byId = sharedStore?.byId ?? new Map();
    this.activeCounts = new Map();
  }

  insert(repo: Repository): void {
    for (const existing of this.byId.values()) {
      if (existing.fullName === repo.fullName) {
        throw new DuplicateRepositoryError({ fullName: repo.fullName });
      }
      if (existing.localBasePath === repo.localBasePath) {
        throw new DuplicateRepositoryError({ localBasePath: repo.localBasePath });
      }
    }
    this.byId.set(repo.id, repo);
  }

  update(id: RepositoryId, patch: RepositoryUpdatePatch, now: Date): void {
    const existing = this.byId.get(id);
    if (!existing) throw new RepositoryNotFoundError(id);
    const next: Repository = {
      ...existing,
      ...(patch.defaultBranch !== undefined ? { defaultBranch: patch.defaultBranch } : {}),
      ...(patch.remoteUrl !== undefined ? { remoteUrl: patch.remoteUrl } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.configMetadata !== undefined ? { configMetadata: patch.configMetadata } : {}),
      ...(patch.healthStatus !== undefined ? { healthStatus: patch.healthStatus } : {}),
      ...(patch.healthError !== undefined ? { healthError: patch.healthError } : {}),
      ...(patch.lastHealthCheckAt !== undefined
        ? { lastHealthCheckAt: patch.lastHealthCheckAt }
        : {}),
      updatedAt: now,
    };
    this.byId.set(id, next);
  }

  remove(id: RepositoryId): void {
    const active = this.activeCounts.get(id) ?? 0;
    if (active > 0) throw new RepositoryHasActiveRunsError(id, active);
    if (!this.byId.has(id)) throw new RepositoryNotFoundError(id);
    this.byId.delete(id);
  }

  findActiveRunCount(id: RepositoryId): number {
    return this.activeCounts.get(id) ?? 0;
  }

  /** Test helper. */
  seedActiveRunCount(id: RepositoryId, count: number): void {
    this.activeCounts.set(id, count);
  }
}
