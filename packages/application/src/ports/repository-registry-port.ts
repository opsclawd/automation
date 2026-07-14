import type { Repository, RepositoryHealthStatus, RepositoryId } from '@ai-sdlc/domain';

export interface RepositoryUpdatePatch {
  defaultBranch?: string;
  remoteUrl?: string;
  enabled?: boolean;
  configMetadata?: string;
  healthStatus?: RepositoryHealthStatus;
  healthError?: string | null;
  lastHealthCheckAt?: Date | null;
  maxConcurrentRuns?: 1;
}

export interface RepositoryRegistryPort {
  insert(repo: Repository): void;
  update(id: RepositoryId, patch: RepositoryUpdatePatch, now: Date): void;
  remove(id: RepositoryId): void;
  /** Count of runs whose status is NOT IN ('passed','failed','cancelled'). */
  findActiveRunCount(id: RepositoryId): number;
}
