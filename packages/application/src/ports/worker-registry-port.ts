import type { RepositoryId, Worker, WorkerId } from '@ai-sdlc/domain';

export interface WorkerRegistryPort {
  register(w: Worker): void;
  heartbeat(id: WorkerId, repoId: RepositoryId, now: Date): void;
  markStopping(id: WorkerId, repoId: RepositoryId): void;
  markUnhealthy(id: WorkerId, repoId: RepositoryId): void;
  markBusy(id: WorkerId, repoId: RepositoryId): void;
  markIdle(id: WorkerId, repoId: RepositoryId): void;
  list(): Worker[];
  findById(id: WorkerId, repoId: RepositoryId): Worker | undefined;
  deregister(id: WorkerId): void;
}
