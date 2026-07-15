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
  /**
   * Resolves after `ms` milliseconds. When `signal` is provided and supported,
   * implementations should settle early (and clear their internal timer) once
   * the signal aborts, so the run loop can shut down promptly without leaking
   * timers.
   */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
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
  seq: number;
  abortController: AbortController;
  dispatchPromise?: Promise<'completed' | 'no_work'>;
};

export class FairRepositoryScheduler {
  private readonly deps: FairRepositorySchedulerDeps;
  private cursorId: RepositoryId | null = null;
  private inFlight = new Map<WorkerId, Reservation>();
  private completionListeners: Array<(repoId: RepositoryId) => void> = [];
  // Capacity claimed by scheduleOnce() calls currently making admission
  // decisions, on top of `inFlight`. Two properties are both required and
  // pull in opposite directions, which is why this needs its own counter
  // rather than just re-reading inFlight.size live:
  //  1. Claims happen one at a time, synchronously, immediately before each
  //     candidate repo's `await inspectRepository`. Two concurrent
  //     scheduleOnce() calls never truly run in parallel — interleaving only
  //     happens at await points — so claiming per-candidate (not the whole
  //     quota up front) lets a second concurrently-started call see this
  //     call's claim and get a fair turn at whatever capacity remains,
  //     instead of the first call grabbing the entire budget before the
  //     second one gets to run at all.
  //  2. A committed claim (one that became a real dispatch) is only released
  //     when the WHOLE scheduleOnce() call finishes, not when the individual
  //     dispatch settles. Dispatches can resolve near-instantly; if a claim
  //     were released as soon as its dispatch's `.finally` ran, `inFlight`
  //     could shrink mid-loop and let this SAME call cascade past its own
  //     fair share by re-claiming the capacity it just freed.
  private claimedSlots = 0;
  private stopped = false;
  private stopReason: string = 'shutdown';

  constructor(deps: FairRepositorySchedulerDeps) {
    this.deps = deps;
  }

  async scheduleOnce(signal?: AbortSignal): Promise<ScheduleOnceResult> {
    if (signal?.aborted) {
      return { admitted: 0, cursorId: this.cursorId };
    }

    if (this.stopped) {
      return { admitted: 0, cursorId: this.cursorId };
    }

    let committedByMe = 0;

    try {
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

      for (let i = 0; i < sorted.length; i++) {
        if (signal?.aborted) break;

        // Claim one slot synchronously, before this iteration's await, so a
        // concurrently-started scheduleOnce() call sees it immediately (see
        // the claimedSlots field comment).
        if (this.inFlight.size + this.claimedSlots >= this.deps.globalConcurrency) break;
        this.claimedSlots++;
        let claimReleased = false;
        const releaseClaim = () => {
          if (!claimReleased) {
            claimReleased = true;
            this.claimedSlots--;
          }
        };

        const index = (startIndex + i) % sorted.length;
        const repo = sorted[index];
        if (!repo) {
          releaseClaim();
          continue;
        }

        const inspection = await this.inspectRepository(repo);

        if (this.stopped) {
          releaseClaim();
          break;
        }

        if (!inspection.available) {
          releaseClaim();
          this.recordRepositorySkipped(repo, inspection.reason!, inspection.detail);
          this.recordQueueDepth(repo, 0);
          continue;
        }

        const usage = Math.max(inspection.activeCount ?? 0, this.countReservedForRepo(repo.id));
        const cap = Math.min(repo.maxConcurrentRuns, this.deps.globalConcurrency);

        if (usage >= cap) {
          releaseClaim();
          this.recordRepositorySkipped(repo, 'at_cap');
          this.recordQueueDepth(repo, inspection.queueDepth ?? 0);
          this.recordActive(repo, usage);
          continue;
        }

        if (inspection.queueDepth === 0) {
          releaseClaim();
          this.recordRepositorySkipped(repo, 'no_work');
          this.recordQueueDepth(repo, 0);
          continue;
        }

        const workerSeq = this.getNextSeq(repo.id);
        const workerId = this.deps.workerIdFactory(repo, workerSeq);

        // Commit: keep the claim held (do not releaseClaim here) until this
        // whole scheduleOnce() call finishes, per the claimedSlots field
        // comment — inFlight is updated now for cross-call accounting, but
        // this call's own budget must not be affected by how fast the
        // dispatch settles.
        committedByMe++;
        const abortController = new AbortController();
        this.inFlight.set(workerId, { repoId: repo.id, workerId, seq: workerSeq, abortController });
        this.recordDispatchStarted(repo, workerId);

        const dispatchPromise = Promise.resolve(
          this.deps.dispatch.runOne({ repository: repo, workerId, signal: abortController.signal }),
        ).finally(() => {
          this.inFlight.delete(workerId);
          this.notifyCompletion(repo.id);
        });
        this.inFlight.get(workerId)!.dispatchPromise = dispatchPromise;

        dispatchPromise.then(
          (outcome) => {
            if (outcome === 'completed') {
              this.recordDispatchCompleted(repo, workerId);
            }
          },
          (err) => {
            this.recordDispatchFailed(repo, workerId, String((err as Error).message));
          },
        );

        this.cursorId = repo.id;
        admitted++;
      }

      this.recordPoolActive(this.inFlight.size);
      this.recordDispatchTotal(admitted);

      return { admitted, cursorId: this.cursorId };
    } finally {
      this.claimedSlots -= committedByMe;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let listenerRef: ((repoId: RepositoryId) => void) | undefined;
      const completionPromise = new Promise<void>((resolve) => {
        const listener = (_repoId: RepositoryId) => {
          this.removeCompletionListener(listener);
          listenerRef = undefined;
          resolve();
        };
        listenerRef = listener;
        this.addCompletionListener(listener);
      });

      try {
        await this.scheduleOnce(signal);
      } catch (err) {
        this.recordTickFailed(String((err as Error).message));
      }

      try {
        await Promise.race([this.deps.sleep(this.deps.pollIntervalMs, signal), completionPromise]);
      } finally {
        if (listenerRef) {
          this.removeCompletionListener(listenerRef);
          listenerRef = undefined;
        }
      }
    }
  }

  stopAdmission(reason: string = 'shutdown'): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    for (const reservation of this.inFlight.values()) {
      reservation.abortController.abort(reason);
    }
  }

  async drain(timeoutMs: number): Promise<{ drained: boolean; remainingWorkerIds: WorkerId[] }> {
    const startTime = this.deps.now();
    const checkTimeout = () => this.deps.now().getTime() - startTime.getTime() >= timeoutMs;

    while (this.inFlight.size > 0) {
      if (checkTimeout()) {
        return {
          drained: false,
          remainingWorkerIds: [...this.inFlight.keys()],
        };
      }
      const reservation = [...this.inFlight.values()][0];
      if (!reservation || !reservation.dispatchPromise) {
        await this.deps.sleep(100);
        continue;
      }
      try {
        await Promise.race([reservation.dispatchPromise, this.deps.sleep(100)]);
      } catch {
        // ignore and continue draining
      }
    }

    return { drained: true, remainingWorkerIds: [] };
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

  // Worker identity is repository-immutable for the worker's active
  // lifetime, but stable *across* dispatch lifetimes too: once a repo's
  // worker slot fully completes and is freed, the next dispatch to that
  // repo reuses the same sequence number (and therefore the same
  // workerIdFactory output), rather than minting a new one forever. Finds
  // the lowest sequence number not currently held by an in-flight
  // reservation for this repo.
  private getNextSeq(repoId: RepositoryId): number {
    const usedSeqs = new Set<number>();
    for (const res of this.inFlight.values()) {
      if (res.repoId === repoId) usedSeqs.add(res.seq);
    }
    let seq = 0;
    while (usedSeqs.has(seq)) seq++;
    return seq;
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
      repository_name: repo.fullName,
      worker_id: workerId,
    };
    this.safeRecord(record);
  }

  private recordDispatchCompleted(repo: Repository, workerId: WorkerId): void {
    const record: SchedulerDispatchCompletedRecord = {
      type: 'scheduler.dispatch.completed',
      repository_id: repo.id,
      repository_name: repo.fullName,
      worker_id: workerId,
    };
    this.safeRecord(record);
  }

  private recordDispatchFailed(repo: Repository, workerId: WorkerId, error: string): void {
    const record: SchedulerDispatchFailedRecord = {
      type: 'scheduler.dispatch.failed',
      repository_id: repo.id,
      repository_name: repo.fullName,
      worker_id: workerId,
      error,
    };
    this.safeRecord(record);
  }

  private recordRepositorySkipped(
    repo: Repository,
    reason: 'disabled' | 'unhealthy' | 'unavailable' | 'at_cap' | 'no_work',
    detail?: string,
  ): void {
    const repository_id = repo.id;
    const repository_name = repo.fullName;
    let record: SchedulerRepositorySkippedRecord;
    switch (reason) {
      case 'unhealthy':
      case 'unavailable':
        record = {
          type: 'scheduler.repository.skipped',
          repository_id,
          repository_name,
          reason,
          detail: detail ?? '',
        };
        break;
      case 'disabled':
      case 'at_cap':
      case 'no_work':
        record = {
          type: 'scheduler.repository.skipped',
          repository_id,
          repository_name,
          reason,
        };
        break;
    }
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
      repository_name: repo.fullName,
      count,
    };
    this.safeRecord(record);
  }

  private recordQueueDepth(repo: Repository, depth: number): void {
    const record: SchedulerRepositoryQueueDepthRecord = {
      type: 'scheduler.repository.queue_depth',
      repository_id: repo.id,
      repository_name: repo.fullName,
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
