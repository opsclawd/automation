import type { Repository, WorkerId } from '@ai-sdlc/domain';
import type {
  RepositoryWorkSourcePort,
  RepositoryDispatchPort,
  SchedulerTelemetryPort,
  RepositoryWorkInspection,
  SchedulerTelemetryRecord,
} from '../ports/repository-scheduler-port.js';

type InspectResult =
  | { available: true; queueDepth: number; activeCount: number }
  | { available: false; reason: 'disabled' | 'unhealthy' | 'unavailable'; detail: string };

export class FakeRepositoryWorkSourcePort implements RepositoryWorkSourcePort {
  private results = new Map<string, InspectResult>();

  setResult(repoId: string, result: InspectResult) {
    this.results.set(repoId, result);
  }

  async inspect(repo: Repository): Promise<RepositoryWorkInspection> {
    const result = this.results.get(String(repo.id));
    if (!result) {
      return { available: true, queueDepth: 0, activeCount: 0 };
    }
    return result as RepositoryWorkInspection;
  }
}

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  promise: Promise<T>;
}

function defer<T>(): Deferred<T> {
  let resolve: (value: T) => void;
  let reject: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve: resolve!, reject: reject!, promise };
}

export class FakeRepositoryDispatchPort implements RepositoryDispatchPort {
  private results = new Map<string, 'completed' | 'no_work'>();
  private calls: Array<{ repository: Repository; workerId: WorkerId; signal?: AbortSignal }> = [];
  private deferredResults = new Map<string, Deferred<'completed' | 'no_work'>>();

  setResult(repoId: string, result: 'completed' | 'no_work') {
    this.results.set(repoId, result);
  }

  async runOne(input: {
    repository: Repository;
    workerId: WorkerId;
    signal?: AbortSignal;
  }): Promise<'completed' | 'no_work'> {
    this.calls.push(input);
    const deferred = this.deferredResults.get(String(input.repository.id));
    if (deferred) {
      return deferred.promise;
    }
    return this.results.get(String(input.repository.id)) ?? 'no_work';
  }

  pendingResult(repoId: string): Deferred<'completed' | 'no_work'> {
    const d = defer<'completed' | 'no_work'>();
    this.deferredResults.set(repoId, d);
    return d;
  }

  resolvePending(repoId: string, result: 'completed' | 'no_work') {
    const d = this.deferredResults.get(repoId);
    if (d) {
      d.resolve(result);
      this.deferredResults.delete(repoId);
    }
  }

  getCalls() {
    return this.calls;
  }

  clear() {
    this.calls = [];
    this.deferredResults.clear();
  }
}

interface TelemetryEntry {
  type: string;
  repository_id?: string;
  repository_name?: string;
  [key: string]: unknown;
}

export class FakeSchedulerTelemetryPort implements SchedulerTelemetryPort {
  readonly records: TelemetryEntry[] = [];
  private shouldThrow = false;

  setShouldThrow(v: boolean) {
    this.shouldThrow = v;
  }

  record(r: SchedulerTelemetryRecord): void | Promise<void> {
    if (this.shouldThrow) throw new Error('telemetry error');
    this.records.push({ ...r } as TelemetryEntry);
  }

  clear() {
    this.records.length = 0;
  }
}
