import {
  type RepositoryId,
  type Worker,
  type WorkerId,
  heartbeatWorker,
  markWorkerStopping,
  markWorkerUnhealthy,
  markWorkerBusy,
  markWorkerIdle,
} from '@ai-sdlc/domain';
import type { WorkerRegistryPort } from '../ports/worker-registry-port.js';

export class FakeWorkerRegistryPort implements WorkerRegistryPort {
  private workers = new Map<WorkerId, Worker>();

  register(w: Worker): void {
    this.workers.set(w.id, w);
  }

  heartbeat(id: WorkerId, repoId: RepositoryId, now: Date): void {
    this.update(id, repoId, (w) => heartbeatWorker(w, now));
  }

  markStopping(id: WorkerId, repoId: RepositoryId): void {
    this.update(id, repoId, markWorkerStopping);
  }

  markUnhealthy(id: WorkerId, repoId: RepositoryId): void {
    this.update(id, repoId, markWorkerUnhealthy);
  }

  markBusy(id: WorkerId, repoId: RepositoryId): void {
    this.update(id, repoId, markWorkerBusy);
  }

  markIdle(id: WorkerId, repoId: RepositoryId): void {
    this.update(id, repoId, markWorkerIdle);
  }

  list(): Worker[] {
    return [...this.workers.values()];
  }

  findById(id: WorkerId, repoId: RepositoryId): Worker | undefined {
    const w = this.workers.get(id);
    if (!w || w.repoId !== repoId) return undefined;
    return w;
  }

  deregister(id: WorkerId): void {
    this.workers.delete(id);
  }

  private update(id: WorkerId, repoId: RepositoryId, fn: (w: Worker) => Worker): void {
    const w = this.workers.get(id);
    if (!w) throw new Error(`unknown worker ${id}`);
    if (w.repoId !== repoId) throw new Error(`worker ${id} is not registered for repo ${repoId}`);
    this.workers.set(id, fn(w));
  }
}
