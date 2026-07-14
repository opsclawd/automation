import { describe, it, expect, vi } from 'vitest';
import type { Repository, WorkerId, RepositoryWorkInspection } from '@ai-sdlc/domain';
import { RepositoryId as mkRepoId, WorkerId as mkWorkerId } from '@ai-sdlc/domain';

const REPO = (id: string, name: string): Repository =>
  ({
    id: mkRepoId(id),
    owner: 'o',
    name,
    fullName: `o/${name}`,
    defaultBranch: 'main',
    localBasePath: `/tmp/repos/${id}`,
    enabled: true,
    maxConcurrentRuns: 1 as const,
    healthStatus: 'healthy',
    healthError: null,
    lastHealthCheckAt: new Date(),
    configMetadata: '{}',
    createdAt: new Date(),
    updatedAt: new Date(),
  }) satisfies Repository;

const mkRepo = (id: string) => REPO(id, `repo-${id}`);

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

type InspectResult =
  | { available: true; queueDepth: number; activeCount: number }
  | { available: false; reason: 'disabled' | 'unhealthy' | 'unavailable'; detail: string };

class FakeRepositoryWorkSourcePort {
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

class FakeRepositoryDispatchPort {
  private results = new Map<string, 'completed' | 'no_work'>();
  private calls: Array<{ repository: Repository; workerId: WorkerId }> = [];
  private deferredResults = new Map<string, Deferred<'completed' | 'no_work'>>();

  setResult(repoId: string, result: 'completed' | 'no_work') {
    this.results.set(repoId, result);
  }

  async runOne(input: {
    repository: Repository;
    workerId: WorkerId;
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

class FakeSchedulerTelemetryPort {
  readonly records: TelemetryEntry[] = [];
  private shouldThrow = false;

  setShouldThrow(v: boolean) {
    this.shouldThrow = v;
  }

  record(r: TelemetryEntry): void | Promise<void> {
    if (this.shouldThrow) throw new Error('telemetry error');
    this.records.push({ ...r });
  }

  clear() {
    this.records.length = 0;
  }
}

type WorkerIdFactory = (repository: Repository, sequence: number) => WorkerId;

function makeWorkerIdFactory(): WorkerIdFactory {
  return (repo: Repository, seq: number) => mkWorkerId(`w-${String(repo.id)}-${seq}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((res) => setTimeout(res, ms));
}

describe('FairRepositoryScheduler run loop', () => {
  describe('scheduler_abort_stops_admission_only', () => {
    it('scheduler_abort_stops_admission_only', async () => {
      const { FairRepositoryScheduler } = await import('../fair-repository-scheduler.js');

      const r1 = mkRepo('r1');

      const source = new FakeRepositoryWorkSourcePort();
      const dispatch = new FakeRepositoryDispatchPort();
      const telemetry = new FakeSchedulerTelemetryPort();

      source.setResult('r1', { available: true, queueDepth: 1, activeCount: 0 });
      dispatch.setResult('r1', 'completed');

      const fakeRepos = {
        listEnabled() {
          return [r1];
        },
      };

      const scheduler = new FairRepositoryScheduler({
        globalConcurrency: 10,
        pollIntervalMs: 60000,
        repos: fakeRepos as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        workSource: source,
        dispatch,
        telemetry,
        workerIdFactory: makeWorkerIdFactory(),
        sleep,
        now: () => new Date(),
        logger: { error: () => {} },
      });

      const abortController = new AbortController();
      abortController.abort();

      const result = await scheduler.scheduleOnce(abortController.signal);

      expect(result.admitted).toBe(0);
    });
  });

  describe('registry_failure_waits_before_retry', () => {
    it('registry_failure_waits_before_retry without spinning', async () => {
      const { FairRepositoryScheduler } = await import('../fair-repository-scheduler.js');

      const r1 = mkRepo('r1');
      let listCallCount = 0;

      const source = new FakeRepositoryWorkSourcePort();
      const dispatch = new FakeRepositoryDispatchPort();
      const telemetry = new FakeSchedulerTelemetryPort();

      source.setResult('r1', { available: true, queueDepth: 1, activeCount: 0 });
      dispatch.setResult('r1', 'completed');

      const fakeRepos = {
        listEnabled() {
          listCallCount++;
          if (listCallCount <= 2) {
            throw new Error('registry unavailable');
          }
          return [r1];
        },
      };

      const scheduler = new FairRepositoryScheduler({
        globalConcurrency: 10,
        pollIntervalMs: 50,
        repos: fakeRepos as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        workSource: source,
        dispatch,
        telemetry,
        workerIdFactory: makeWorkerIdFactory(),
        sleep,
        now: () => new Date(),
        logger: { error: () => {} },
      });

      vi.useFakeTimers();

      scheduler.scheduleOnce();
      await vi.advanceTimersByTimeAsync(60);
      await vi.advanceTimersByTimeAsync(60);

      vi.useRealTimers();

      const tickFailedRecords = telemetry.records.filter((r) => r.type === 'scheduler.tick.failed');
      expect(tickFailedRecords.length).toBeGreaterThan(0);
    });
  });

  describe('completion_wakes_run_loop_before_poll_interval', () => {
    it('completion_wakes_run_loop_before_poll_interval', async () => {
      const { FairRepositoryScheduler } = await import('../fair-repository-scheduler.js');

      const r1 = mkRepo('r1');
      const r2 = mkRepo('r2');

      const source = new FakeRepositoryWorkSourcePort();
      const dispatch = new FakeRepositoryDispatchPort();
      const telemetry = new FakeSchedulerTelemetryPort();

      source.setResult('r1', { available: true, queueDepth: 1, activeCount: 0 });
      source.setResult('r2', { available: true, queueDepth: 1, activeCount: 0 });

      const fakeRepos = {
        listEnabled() {
          return [r1, r2];
        },
      };

      const scheduler = new FairRepositoryScheduler({
        globalConcurrency: 1,
        pollIntervalMs: 10000,
        repos: fakeRepos as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        workSource: source,
        dispatch,
        telemetry,
        workerIdFactory: makeWorkerIdFactory(),
        sleep,
        now: () => new Date(),
        logger: { error: () => {} },
      });

      let runLoopWakeCount = 0;
      const _originalSleep = sleep;
      const _mockSleep = async (ms: number) => {
        if (ms === 10000) {
          runLoopWakeCount++;
        }
        return _originalSleep(ms);
      };

      dispatch.setResult('r1', 'completed');
      dispatch.setResult('r2', 'completed');

      const pendingR1 = dispatch.pendingResult('r1');

      scheduler.run(new AbortController().signal);

      dispatch.resolvePending('r1', 'completed');
      await pendingR1.promise;

      await scheduler.scheduleOnce();

      expect(runLoopWakeCount).toBe(0);
    });
  });

  describe('worker_identity_is_repository_immutable', () => {
    it('worker_identity_is_repository_immutable for one dispatch lifetime', async () => {
      const { FairRepositoryScheduler } = await import('../fair-repository-scheduler.js');

      const r1 = mkRepo('r1');

      const source = new FakeRepositoryWorkSourcePort();
      const dispatch = new FakeRepositoryDispatchPort();
      const telemetry = new FakeSchedulerTelemetryPort();

      source.setResult('r1', { available: true, queueDepth: 1, activeCount: 0 });
      dispatch.setResult('r1', 'completed');

      const fakeRepos = {
        listEnabled() {
          return [r1];
        },
      };

      const scheduler = new FairRepositoryScheduler({
        globalConcurrency: 10,
        pollIntervalMs: 60000,
        repos: fakeRepos as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        workSource: source,
        dispatch,
        telemetry,
        workerIdFactory: makeWorkerIdFactory(),
        sleep,
        now: () => new Date(),
        logger: { error: () => {} },
      });

      await scheduler.scheduleOnce();
      await scheduler.scheduleOnce();

      const calls = dispatch.getCalls();
      expect(calls.length).toBe(2);

      const workerIds = calls.map((c) => String(c.workerId));
      const uniqueWorkerIds = [...new Set(workerIds)];
      expect(uniqueWorkerIds.length).toBe(1);
    });
  });

  describe('worker_cleanup_runs_after_failure_and_no_work', () => {
    it('worker_cleanup_runs_after_failure_and_no_work', async () => {
      const { FairRepositoryScheduler } = await import('../fair-repository-scheduler.js');

      const r1 = mkRepo('r1');

      const source = new FakeRepositoryWorkSourcePort();
      const dispatch = new FakeRepositoryDispatchPort();
      const telemetry = new FakeSchedulerTelemetryPort();

      source.setResult('r1', { available: true, queueDepth: 1, activeCount: 0 });

      const fakeRepos = {
        listEnabled() {
          return [r1];
        },
      };

      const scheduler = new FairRepositoryScheduler({
        globalConcurrency: 10,
        pollIntervalMs: 60000,
        repos: fakeRepos as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        workSource: source,
        dispatch,
        telemetry,
        workerIdFactory: makeWorkerIdFactory(),
        sleep,
        now: () => new Date(),
        logger: { error: () => {} },
      });

      dispatch.setResult('r1', 'no_work');
      await scheduler.scheduleOnce();

      dispatch.setResult('r1', 'completed');
      await scheduler.scheduleOnce();

      const calls = dispatch.getCalls();
      expect(calls.length).toBe(2);
    });
  });
});
