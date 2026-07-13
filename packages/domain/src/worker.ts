import type { RepositoryId, WorkerId } from './ids.js';
export type WorkerStatus = 'idle' | 'busy' | 'stopping' | 'unhealthy';
export interface Worker {
  id: WorkerId;
  repoId: RepositoryId;
  hostname: string;
  processId: number;
  status: WorkerStatus;
  heartbeatAt: Date;
}
export interface CreateWorkerInput {
  id: WorkerId;
  repoId: RepositoryId;
  hostname: string;
  processId: number;
  now: Date;
}
export function createWorker(input: CreateWorkerInput): Worker {
  return {
    id: input.id,
    repoId: input.repoId,
    hostname: input.hostname,
    processId: input.processId,
    status: 'idle',
    heartbeatAt: input.now,
  };
}
export function heartbeatWorker(w: Worker, now: Date): Worker {
  return { ...w, heartbeatAt: now };
}
export function markWorkerBusy(w: Worker): Worker {
  return { ...w, status: 'busy' };
}
export function markWorkerIdle(w: Worker): Worker {
  if (w.status === 'stopping' || w.status === 'unhealthy') {
    return w;
  }
  return { ...w, status: 'idle' };
}
export function markWorkerStopping(w: Worker): Worker {
  return { ...w, status: 'stopping' };
}
export function markWorkerUnhealthy(w: Worker): Worker {
  return { ...w, status: 'unhealthy' };
}
