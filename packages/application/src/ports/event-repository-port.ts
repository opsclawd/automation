import type { RepositoryId } from '@ai-sdlc/domain';

export interface EventRepositoryPort {
  insert(event: {
    runUuid: string;
    phase?: string;
    level: string;
    type: string;
    message: string;
    metadata?: Record<string, unknown>;
    timestamp: Date;
  }): number;
  listByRunSince(
    runUuid: string,
    sinceIso?: string,
  ): Array<{
    id: number;
    runUuid: string;
    repoId: RepositoryId;
    phase?: string;
    level: string;
    type: string;
    message: string;
    metadata: Record<string, unknown>;
    timestamp: Date;
  }>;
}
