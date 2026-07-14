import type { Repository, RepositoryId, WorkerId } from '@ai-sdlc/domain';
import type {
  RepositoryWorkSourcePort,
  RepositoryDispatchPort,
  SchedulerTelemetryPort,
  SchedulerTelemetryRecord,
  SchedulerDispatchStartedRecord,
  SchedulerDispatchCompletedRecord,
  SchedulerDispatchFailedRecord,
  SchedulerRepositorySkippedRecord,
  SchedulerTickFailedRecord,
  SchedulerPoolActiveRecord,
  SchedulerRepositoryActiveRecord,
  SchedulerRepositoryQueueDepthRecord,
  SchedulerDispatchTotalRecord,
} from './ports/repository-scheduler-port.js';
import type { LoggerPort } from './ports/logger-port.js';

export interface FairRepositorySchedulerDeps {
  globalConcurrency: number;
  pollIntervalMs: number;
  repos: {
    listEnabled(): Repository[];
  };
  workSource: RepositoryWorkSourcePort;
  dispatch: RepositoryDispatchPort;
  telemetry: SchedulerTelemetryPort;
  workerIdFactory: (repository: Repository, sequence: number) => WorkerId;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  logger: LoggerPort;
}

export interface ScheduleOnceResult {
  admitted: number;
  cursorId: RepositoryId | null;
}

type Reservation = {
  repoId: RepositoryId;
  workerId: WorkerId;
};

export class FairRepositoryScheduler {
  private readonly deps: FairRepositorySchedulerDeps;
  private cursorId: RepositoryId | null = null;
  private inFlight = new Map<WorkerId, Reservation>();
  private nextSeqByRepoId = new Map<RepositoryId, number>();
  private completionListeners: Array<(repoId: RepositoryId) => void> = [];

  constructor(deps: FairRepositorySchedulerDeps) {
    this.deps = deps;
  }

  async scheduleOnce(signal?: AbortSignal): Promise<ScheduleOnceResult> {
    if (signal?.aborted) {
      return { admitted: 0, cursorId: this.cursorId };
    }

    const availableSlots = this.deps.globalConcurrency - this.inFlight.size;
    if (availableSlots <= 0) {
      return { admitted: 0, cursorId: this.cursorId };
    }

    let repos: Repository[];
    try {
      repos = this.deps.repos.listEnabled();
    } catch (err) {
      this.recordTickFailed(String((err as Error).message));
      return { admitted: 0, cursorId: this.cursorId };
    }

    if (repos.length === 0) {
      return { admitted: 0, cursorId: this.cursorId };
    }

    const sorted = [...repos].sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const startIndex = this.findStartIndex(sorted);
    let admitted = 0;
    let wrapped = false;
    const visited = new Set<RepositoryId>();

    for (let i = 0; i < sorted.length; i++) {
      if (signal?.aborted) break;
      if (admitted >= availableSlots) break;

      const index = (startIndex + i) % sorted.length;
      const repo = sorted[index];
      if (!repo) continue;

      if (visited.has(repo.id)) continue;
      if (wrapped && index <= startIndex) break;
      visited.add(repo.id);

      const inspection = await this.inspectRepository(repo);

      if (!inspection.available) {
        this.recordRepositorySkipped(repo, inspection.reason!, inspection.detail ?? '');
        this.recordQueueDepth(repo, 0);
        continue;
      }

      const usage = Math.max(inspection.activeCount ?? 0, this.countReservedForRepo(repo.id));
      const cap = Math.min(repo.maxConcurrentRuns, this.deps.globalConcurrency);

      if (usage >= cap) {
        this.recordRepositorySkipped(repo, 'at_cap', '');
        this.recordQueueDepth(repo, inspection.queueDepth ?? 0);
        this.recordActive(repo, usage);
        continue;
      }

      if (inspection.queueDepth === 0) {
        this.recordRepositorySkipped(repo, 'no_work', '');
        this.recordQueueDepth(repo, 0);
        continue;
      }

      const workerSeq = this.getNextSeq(repo.id);
      const workerId = this.deps.workerIdFactory(repo, workerSeq);

      this.inFlight.set(workerId, { repoId: repo.id, workerId });
      this.recordDispatchStarted(repo, workerId);

      const dispatchPromise = this.deps.dispatch
        .runOne({ repository: repo, workerId })
        .finally(() => {
          this.inFlight.delete(workerId);
          this.notifyCompletion(repo.id);
        });

      dispatchPromise
        .then(() => this.recordDispatchCompleted(repo, workerId))
        .catch((err) => {
          this.recordDispatchFailed(repo, workerId, String((err as Error).message));
        });

      this.cursorId = repo.id;
      admitted++;

      if (admitted >= availableSlots) break;
      if (wrapped && index >= startIndex) break;
    }

    this.recordPoolActive(this.inFlight.size);
    this.recordDispatchTotal(admitted);

    return { admitted, cursorId: this.cursorId };
  }

  async run(signal: AbortSignal): Promise<void> {
    const abortAwareSleep = (ms: number): Promise<void> => {
      return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(), ms);
        const onAbort = () => {
          clearTimeout(timeout);
          resolve();
        };
        signal.addEventListener('abort', onAbort);
        setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
        }, ms);
      });
    };

    while (!signal.aborted) {
      let listenerRef: ((repoId: RepositoryId) => void) | undefined;
      const nextCompletion = (): Promise<(repoId: RepositoryId) => void> => {
        return new Promise((resolve) => {
          const listener = (_repoId: RepositoryId) => {
            this.removeCompletionListener(listener);
            resolve(listener);
          };
          listenerRef = listener;
          this.addCompletionListener(listener);
        });
      };

      const completionPromise = nextCompletion();

      try {
        await this.scheduleOnce(signal);
      } catch (err) {
        this.recordTickFailed(String((err as Error).message));
      }

      const raceResult = await Promise.race([
        abortAwareSleep(this.deps.pollIntervalMs),
        completionPromise,
      ]);

      if (raceResult === undefined && listenerRef) {
        this.removeCompletionListener(listenerRef);
      }
    }
  }

  private async inspectRepository(repo: Repository): Promise<{
    available: boolean;
    reason?: 'disabled' | 'unhealthy' | 'unavailable';
    detail?: string;
    queueDepth?: number;
    activeCount?: number;
  }> {
    try {
      const inspection = await this.deps.workSource.inspect(repo);
      if (!inspection.available) {
        return inspection;
      }
      this.recordActive(repo, inspection.activeCount);
      this.recordQueueDepth(repo, inspection.queueDepth);
      return inspection;
    } catch (err) {
      this.recordRepositorySkipped(repo, 'unavailable', String((err as Error).message));
      return { available: false, reason: 'unavailable', detail: String((err as Error).message) };
    }
  }

  private findStartIndex(sorted: Repository[]): number {
    if (this.cursorId === null) return 0;

    const cursorIdx = sorted.findIndex((r) => r.id === this.cursorId);
    if (cursorIdx === -1) {
      const successorIdx = sorted.findIndex((r) => String(r.id) > String(this.cursorId!));
      return successorIdx === -1 ? 0 : successorIdx;
    }

    return (cursorIdx + 1) % sorted.length;
  }

  private countReservedForRepo(repoId: RepositoryId): number {
    let count = 0;
    for (const res of this.inFlight.values()) {
      if (res.repoId === repoId) count++;
    }
    return count;
  }

  private getNextSeq(repoId: RepositoryId): number {
    const current = this.nextSeqByRepoId.get(repoId) ?? 0;
    this.nextSeqByRepoId.set(repoId, current + 1);
    return current;
  }

  private addCompletionListener(listener: (repoId: RepositoryId) => void): void {
    this.completionListeners.push(listener);
  }

  private removeCompletionListener(listener: (repoId: RepositoryId) => void): void {
    const idx = this.completionListeners.indexOf(listener);
    if (idx !== -1) this.completionListeners.splice(idx, 1);
  }

  private notifyCompletion(repoId: RepositoryId): void {
    for (const listener of [...this.completionListeners]) {
      try {
        listener(repoId);
      } catch {
        // ignore
      }
    }
  }

  private safeRecord(record: SchedulerTelemetryRecord): void {
    try {
      const result = this.deps.telemetry.record(record);
      if (result instanceof Promise) {
        result.catch((err) => {
          this.deps.logger.error('telemetry record failed', err);
        });
      }
    } catch (err) {
      this.deps.logger.error('telemetry record failed', err);
    }
  }

  private recordDispatchStarted(repo: Repository, workerId: WorkerId): void {
    const record: SchedulerDispatchStartedRecord = {
      type: 'scheduler.dispatch.started',
      repository_id: repo.id,
      repository_name: repo.name,
      worker_id: workerId,
    };
    this.safeRecord(record);
  }

  private recordDispatchCompleted(repo: Repository, workerId: WorkerId): void {
    const record: SchedulerDispatchCompletedRecord = {
      type: 'scheduler.dispatch.completed',
      repository_id: repo.id,
      repository_name: repo.name,
      worker_id: workerId,
    };
    this.safeRecord(record);
  }

  private recordDispatchFailed(repo: Repository, workerId: WorkerId, error: string): void {
    const record: SchedulerDispatchFailedRecord = {
      type: 'scheduler.dispatch.failed',
      repository_id: repo.id,
      repository_name: repo.name,
      worker_id: workerId,
      error,
    };
    this.safeRecord(record);
  }

  private recordRepositorySkipped(
    repo: Repository,
    reason: 'disabled' | 'unhealthy' | 'unavailable' | 'at_cap' | 'no_work',
    detail: string,
  ): void {
    const record: SchedulerRepositorySkippedRecord = {
      type: 'scheduler.repository.skipped',
      repository_id: repo.id,
      repository_name: repo.name,
      reason,
      ...(detail ? { detail } : {}),
    } as SchedulerRepositorySkippedRecord;
    this.safeRecord(record);
  }

  private recordTickFailed(error: string): void {
    const record: SchedulerTickFailedRecord = {
      type: 'scheduler.tick.failed',
      error,
    };
    this.safeRecord(record);
  }

  private recordPoolActive(count: number): void {
    const record: SchedulerPoolActiveRecord = {
      type: 'scheduler.pool.active',
      count,
    };
    this.safeRecord(record);
  }

  private recordActive(repo: Repository, count: number): void {
    const record: SchedulerRepositoryActiveRecord = {
      type: 'scheduler.repository.active',
      repository_id: repo.id,
      repository_name: repo.name,
      count,
    };
    this.safeRecord(record);
  }

  private recordQueueDepth(repo: Repository, depth: number): void {
    const record: SchedulerRepositoryQueueDepthRecord = {
      type: 'scheduler.repository.queue_depth',
      repository_id: repo.id,
      repository_name: repo.name,
      depth,
    };
    this.safeRecord(record);
  }

  private recordDispatchTotal(count: number): void {
    const record: SchedulerDispatchTotalRecord = {
      type: 'scheduler.dispatch.total',
      count,
    };
    this.safeRecord(record);
  }
}
