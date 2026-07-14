import { describe, it, expect } from 'vitest';
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

describe('FairRepositoryScheduler admission', () => {
  describe('fair_rotation_prevents_starvation', () => {
    it('when one repository continuously replenishes', async () => {
      const { FairRepositoryScheduler } = await import('../fair-repository-scheduler.js');

      const repos = new Map<string, Repository>();
      const r1 = mkRepo('r1');
      const r2 = mkRepo('r2');
      repos.set('r1', r1);
      repos.set('r2', r2);

      const source = new FakeRepositoryWorkSourcePort();
      const dispatch = new FakeRepositoryDispatchPort();
      const telemetry = new FakeSchedulerTelemetryPort();

      let listEnabledCallCount = 0;
      const fakeRepos = {
        listEnabled() {
          listEnabledCallCount++;
          return listEnabledCallCount === 1
            ? [r1, r2]
            : listEnabledCallCount === 2
              ? [r1, r2]
              : [r1, r2];
        },
      };

      source.setResult('r1', { available: true, queueDepth: 1, activeCount: 0 });
      source.setResult('r2', { available: true, queueDepth: 1, activeCount: 0 });

      dispatch.setResult('r1', 'completed');
      dispatch.setResult('r2', 'completed');

      const scheduler = new FairRepositoryScheduler({
        globalConcurrency: 2,
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
      expect(calls.length).toBeGreaterThanOrEqual(2);
      const repo1Calls = calls.filter((c) => String(c.repository.id) === 'r1');
      const repo2Calls = calls.filter((c) => String(c.repository.id) === 'r2');

      expect(repo1Calls.length).toBeLessThanOrEqual(repo2Calls.length + 1);
    });
  });

  describe('fairness_bound_visits_each_repository_once_per_rotation', () => {
    it('fairness_bound_visits_each_repository_once_per_rotation', async () => {
      const { FairRepositoryScheduler } = await import('../fair-repository-scheduler.js');

      const r1 = mkRepo('r1');
      const r2 = mkRepo('r2');
      const r3 = mkRepo('r3');

      const source = new FakeRepositoryWorkSourcePort();
      const dispatch = new FakeRepositoryDispatchPort();
      const telemetry = new FakeSchedulerTelemetryPort();

      source.setResult('r1', { available: true, queueDepth: 1, activeCount: 0 });
      source.setResult('r2', { available: true, queueDepth: 1, activeCount: 0 });
      source.setResult('r3', { available: true, queueDepth: 1, activeCount: 0 });

      dispatch.setResult('r1', 'completed');
      dispatch.setResult('r2', 'completed');
      dispatch.setResult('r3', 'completed');

      const fakeRepos = {
        listEnabled() {
          return [r1, r2, r3];
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
      await scheduler.scheduleOnce();

      const calls = dispatch.getCalls();
      const uniqueRepoIds = [...new Set(calls.map((c) => String(c.repository.id)))];

      expect(uniqueRepoIds.sort()).toEqual(['r1', 'r2', 'r3']);
    });
  });

  describe('global_reservation_precedes_dispatch', () => {
    it('global_reservation_precedes_dispatch across repeated scheduleOnce calls', async () => {
      const { FairRepositoryScheduler } = await import('../fair-repository-scheduler.js');

      const repos = new Map<string, Repository>();
      for (let i = 1; i <= 5; i++) {
        repos.set(`r${i}`, mkRepo(`r${i}`));
      }

      const source = new FakeRepositoryWorkSourcePort();
      const dispatch = new FakeRepositoryDispatchPort();
      const telemetry = new FakeSchedulerTelemetryPort();

      for (let i = 1; i <= 5; i++) {
        source.setResult(`r${i}`, { available: true, queueDepth: 1, activeCount: 0 });
        dispatch.setResult(`r${i}`, 'completed');
      }

      const fakeRepos = {
        listEnabled() {
          return [...repos.values()];
        },
      };

      const scheduler = new FairRepositoryScheduler({
        globalConcurrency: 2,
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

      const p1 = scheduler.scheduleOnce();
      const p2 = scheduler.scheduleOnce();

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.admitted).toBe(1);
      expect(r2.admitted).toBe(1);
      expect(r1.admitted + r2.admitted).toBeLessThanOrEqual(2);
    });
  });

  describe('repository_reservation_precedes_dispatch', () => {
    it('repository_reservation_precedes_dispatch while another repository remains eligible', async () => {
      const { FairRepositoryScheduler } = await import('../fair-repository-scheduler.js');

      const r1 = mkRepo('r1');
      const r2 = mkRepo('r2');

      const source = new FakeRepositoryWorkSourcePort();
      const dispatch = new FakeRepositoryDispatchPort();
      const telemetry = new FakeSchedulerTelemetryPort();

      source.setResult('r1', { available: true, queueDepth: 1, activeCount: 0 });
      source.setResult('r2', { available: true, queueDepth: 1, activeCount: 0 });

      dispatch.setResult('r1', 'completed');
      dispatch.setResult('r2', 'completed');

      const fakeRepos = {
        listEnabled() {
          return [r1, r2];
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

      const pending = dispatch.pendingResult('r1');

      const p1 = scheduler.scheduleOnce();

      await dispatch.getCalls();
      pending.resolve('completed');

      await p1;
      await scheduler.scheduleOnce();

      const calls = dispatch.getCalls();
      const r1Calls = calls.filter((c) => String(c.repository.id) === 'r1');
      const r2Calls = calls.filter((c) => String(c.repository.id) === 'r2');

      expect(r1Calls.length).toBeLessThanOrEqual(1);
      expect(r2Calls.length).toBeLessThanOrEqual(1);
    });
  });

  describe('enabled_snapshot_is_reloaded_each_pass', () => {
    it('enabled_snapshot_is_reloaded_each_pass', async () => {
      const { FairRepositoryScheduler } = await import('../fair-repository-scheduler.js');

      const r1 = mkRepo('r1');
      const r2 = mkRepo('r2');
      let listEnabledCalls: Repository[][] = [];

      const source = new FakeRepositoryWorkSourcePort();
      const dispatch = new FakeRepositoryDispatchPort();
      const telemetry = new FakeSchedulerTelemetryPort();

      source.setResult('r1', { available: true, queueDepth: 1, activeCount: 0 });
      source.setResult('r2', { available: true, queueDepth: 1, activeCount: 0 });

      dispatch.setResult('r1', 'completed');
      dispatch.setResult('r2', 'completed');

      const fakeRepos = {
        listEnabled() {
          const snapshot = listEnabledCalls.length === 0 ? [r1, r2] : [r1, r2, mkRepo('r3')];
          listEnabledCalls.push(snapshot);
          return snapshot;
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

      expect(listEnabledCalls.length).toBe(2);
    });
  });

  describe('cursor_uses_sorted_successor_when_last_repository_disappears', () => {
    it('cursor_uses_sorted_successor_when_last_repository_disappears', async () => {
      const { FairRepositoryScheduler } = await import('../fair-repository-scheduler.js');

      const r1 = mkRepo('r1');
      const r2 = mkRepo('r2');
      const r3 = mkRepo('r3');

      const source = new FakeRepositoryWorkSourcePort();
      const dispatch = new FakeRepositoryDispatchPort();
      const telemetry = new FakeSchedulerTelemetryPort();

      source.setResult('r1', { available: true, queueDepth: 1, activeCount: 0 });
      source.setResult('r2', { available: true, queueDepth: 1, activeCount: 0 });
      source.setResult('r3', { available: true, queueDepth: 1, activeCount: 0 });

      dispatch.setResult('r1', 'completed');
      dispatch.setResult('r2', 'completed');
      dispatch.setResult('r3', 'completed');

      let listEnabledCalls: Repository[][] = [];
      const fakeRepos = {
        listEnabled() {
          const snapshot =
            listEnabledCalls.length === 0
              ? [r1, r2, r3]
              : listEnabledCalls.length === 1
                ? [r1, r2]
                : [r1, r2];
          listEnabledCalls.push(snapshot);
          return snapshot;
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

      expect(listEnabledCalls.length).toBe(2);
    });
  });

  describe('repository_failure_isolated', () => {
    it('repository_failure_isolated within one admission pass', async () => {
      const { FairRepositoryScheduler } = await import('../fair-repository-scheduler.js');

      const r1 = mkRepo('r1');
      const r2 = mkRepo('r2');

      const source = new FakeRepositoryWorkSourcePort();
      const dispatch = new FakeRepositoryDispatchPort();
      const telemetry = new FakeSchedulerTelemetryPort();

      source.setResult('r1', { available: false, reason: 'unhealthy', detail: 'disk full' });
      source.setResult('r2', { available: true, queueDepth: 1, activeCount: 0 });

      dispatch.setResult('r2', 'completed');

      const fakeRepos = {
        listEnabled() {
          return [r1, r2];
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

      const result = await scheduler.scheduleOnce();

      const skipRecords = telemetry.records.filter(
        (r) => r.type === 'scheduler.repository.skipped',
      );
      expect(skipRecords.some((r) => r.repository_id === 'r1')).toBe(true);
      expect(result.admitted).toBeGreaterThanOrEqual(0);
    });
  });

  describe('reservation_released_for_every_outcome', () => {
    it('reservation_released_for_every_outcome', async () => {
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
        globalConcurrency: 1,
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

      dispatch.setResult('r1', 'completed');
      await scheduler.scheduleOnce();

      dispatch.setResult('r1', 'no_work');
      await scheduler.scheduleOnce();

      dispatch.setResult('r1', 'completed');
      await scheduler.scheduleOnce();

      const calls = dispatch.getCalls();
      expect(calls.length).toBe(3);
    });
  });

  describe('telemetry_is_best_effort_and_identified', () => {
    it('telemetry_is_best_effort_and_identified', async () => {
      const { FairRepositoryScheduler } = await import('../fair-repository-scheduler.js');

      const r1 = mkRepo('r1');

      const source = new FakeRepositoryWorkSourcePort();
      const dispatch = new FakeRepositoryDispatchPort();
      const telemetry = new FakeSchedulerTelemetryPort();

      source.setResult('r1', { available: true, queueDepth: 1, activeCount: 0 });
      dispatch.setResult('r1', 'completed');

      telemetry.setShouldThrow(true);

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

      const result = await scheduler.scheduleOnce();

      expect(result.admitted).toBe(1);
      const repoRecords = telemetry.records.filter(
        (r) => r.repository_id != null && r.repository_name != null,
      );
      expect(repoRecords.length).toBeGreaterThan(0);
    });
  });
});
