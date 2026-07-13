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

  heartbeat(id: WorkerId, _repoId: RepositoryId, now: Date): void {
    this.update(id, (w) => heartbeatWorker(w, now));
  }

  markStopping(id: WorkerId, _repoId: RepositoryId): void {
    this.update(id, markWorkerStopping);
  }

  markUnhealthy(id: WorkerId, _repoId: RepositoryId): void {
    this.update(id, markWorkerUnhealthy);
  }

  markBusy(id: WorkerId, _repoId: RepositoryId): void {
    this.update(id, markWorkerBusy);
  }

  markIdle(id: WorkerId, _repoId: RepositoryId): void {
    this.update(id, markWorkerIdle);
  }

  list(): Worker[] {
    return [...this.workers.values()];
  }

  findById(id: WorkerId, _repoId: RepositoryId): Worker | undefined {
    return this.workers.get(id);
  }

  deregister(id: WorkerId): void {
    this.workers.delete(id);
  }

  private update(id: WorkerId, fn: (w: Worker) => Worker): void {
    const w = this.workers.get(id);
    if (!w) throw new Error(`unknown worker ${id}`);
    this.workers.set(id, fn(w));
  }
}
