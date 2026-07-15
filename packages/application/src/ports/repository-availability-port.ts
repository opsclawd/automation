import type { RepositoryId } from '@ai-sdlc/domain';

export interface RepositoryAvailabilityPort {
  markUnreachable(repoId: RepositoryId, reason: string): void;
}
