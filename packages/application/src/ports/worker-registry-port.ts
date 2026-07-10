import type { Worker, WorkerId } from '@ai-sdlc/domain';

export interface WorkerRegistryPort {
  register(w: Worker): void;
  heartbeat(id: WorkerId, now: Date): void;
  markStopping(id: WorkerId): void;
  markUnhealthy(id: WorkerId): void;
  markBusy(id: WorkerId): void;
  markIdle(id: WorkerId): void;
  list(): Worker[];
  findById(id: WorkerId): Worker | undefined;
  deregister(id: WorkerId): void;
}
