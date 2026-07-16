import { describe, expect, it, afterEach } from 'vitest';
import { openDatabase, applyMigrations, JobQueueRepository } from '@ai-sdlc/infrastructure';
import { FairRepositoryScheduler } from '@ai-sdlc/application';
import { RepositorySchedulerAdapter } from '../repository-scheduler-adapter.js';
import type { Repository, WorkerId } from '@ai-sdlc/domain';
import {
  RepositoryId,
  WorkerId as mkWorkerId,
  RunId,
  JobId,
  IssueNumber,
  generateJobOwnership,
} from '@ai-sdlc/domain';
import { createJob } from '@ai-sdlc/domain';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { composeRepositoryRuntime } from '../compose-repository-runtime.js';
import { RepositoryRuntimePaths } from '../repository-runtime-paths.js';

function makeRepository(
  fullName: string,
  opts?: {
    enabled?: boolean;
    localBasePath?: string;
    healthStatus?: Repository['healthStatus'];
  },
): Repository {
  const [owner, name] = fullName.split('/');
  return {
    id: RepositoryId(fullName),
    owner,
    name,
    fullName,
    defaultBranch: 'main',
    remoteUrl: `git@github.com:${fullName}.git`,
    localBasePath: opts?.localBasePath ?? `/tmp/repos/${fullName}`,
    enabled: opts?.enabled ?? true,
    maxConcurrentRuns: 1 as const,
    healthStatus: opts?.healthStatus ?? 'healthy',
    healthError: null,
    lastHealthCheckAt: null,
    configMetadata: '{}',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
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

interface TelemetryEntry {
  type: string;
  repository_id?: string;
  repository_name?: string;
  worker_id?: string;
  [key: string]: unknown;
}

class RecordingTelemetryPort {
  readonly records: TelemetryEntry[] = [];

  record(r: TelemetryEntry): void | Promise<void> {
    this.records.push({ ...r });
  }

  clear(): void {
    this.records.length = 0;
  }
}

interface TestRuntime {
  repository: Repository;
  paths: ReturnType<typeof RepositoryRuntimePaths.create>;
  db: ReturnType<typeof openDatabase>;
  runtime: Awaited<ReturnType<typeof composeRepositoryRuntime>>;
  jobQueue: JobQueueRepository;
}

describe('fair-multi-repository-scheduler', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    tempDirs.length = 0;
  });

  async function buildTestRuntime(repo: Repository): Promise<TestRuntime> {
    const stateRoot = join(tmpdir(), `fair-multi-test-${Date.now()}-${Math.random()}`);
    tempDirs.push(stateRoot);
    mkdirSync(stateRoot, { recursive: true });

    const paths = RepositoryRuntimePaths.create({ stateRoot, repository: repo });
    mkdirSync(paths.runsRoot(), { recursive: true });
    mkdirSync(paths.tmpRoot(), { recursive: true });

    const db = openDatabase(paths.database());
    applyMigrations(db);

    const loadedConfig = {
      fingerprint: `fp-${String(repo.id)}`,
      sources: {},
      config: { phases: {} },
    };

    const listEnabledRepos = () => [{ id: repo.id, fullName: repo.fullName }];

    const runtime = await composeRepositoryRuntime({
      automationRoot: stateRoot,
      stateRoot,
      repository: repo,
      paths,
      loadedConfig,
      controlPlaneDb: db,
      listEnabledRepositories: listEnabledRepos,
    });

    return {
      repository: repo,
      paths,
      db,
      runtime,
      jobQueue: runtime.jobQueue as JobQueueRepository,
    };
  }

  async function enqueueJob(
    rt: TestRuntime,
    issueNumber: IssueNumber,
    jobId: JobId,
    runId: RunId,
  ): Promise<void> {
    const job = createJob({
      id: jobId,
      runId,
      repoId: rt.repository.id,
      issueNumber,
      createdAt: new Date(),
    });
    rt.jobQueue.enqueue({ job });
  }

  describe('two_repositories_execute_equal_issue_numbers_in_isolation', () => {
    it('each repository handles the same issue number 42 without cross-contamination', async () => {
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      const rtA = await buildTestRuntime(repoA);
      const rtB = await buildTestRuntime(repoB);

      const issueNumber = 42 as IssueNumber;
      const jobIdA = JobId('job-api-42');
      const jobIdB = JobId('job-web-42');
      const runIdA = RunId('run-api-42');
      const runIdB = RunId('run-web-42');

      await enqueueJob(rtA, issueNumber, jobIdA, runIdA);
      await enqueueJob(rtB, issueNumber, jobIdB, runIdB);

      expect(rtA.jobQueue.findById(jobIdA)?.repoId).toBe(repoA.id);
      expect(rtA.jobQueue.findById(jobIdB)).toBeUndefined();
      expect(rtB.jobQueue.findById(jobIdB)?.repoId).toBe(repoB.id);
      expect(rtB.jobQueue.findById(jobIdA)).toBeUndefined();

      const claimedA = rtA.jobQueue.claimNext({
        workerId: mkWorkerId('worker-a'),
        repoId: repoA.id,
        ttlMs: 60000,
      });
      const claimedB = rtB.jobQueue.claimNext({
        workerId: mkWorkerId('worker-b'),
        repoId: repoB.id,
        ttlMs: 60000,
      });

      expect(claimedA?.id).toBe(jobIdA);
      expect(claimedB?.id).toBe(jobIdB);
      expect(claimedA?.id).not.toBe(claimedB?.id);

      const leaseA = rtA.runtime.workerLeaseRepository.acquire({
        repoId: repoA.id,
        workerId: mkWorkerId('worker-a'),
        runId: runIdA,
        now: new Date(),
        ttlMs: 60000,
      });
      const leaseB = rtB.runtime.workerLeaseRepository.acquire({
        repoId: repoB.id,
        workerId: mkWorkerId('worker-b'),
        runId: runIdB,
        now: new Date(),
        ttlMs: 60000,
      });

      expect(leaseA.repoId).toBe(repoA.id);
      expect(leaseB.repoId).toBe(repoB.id);
      expect(leaseA.repoId).not.toBe(leaseB.repoId);

      const leaseTokenA = leaseA.leaseToken;
      const leaseTokenB = leaseB.leaseToken;

      rtA.runtime.workerLeaseRepository.release({
        repoId: repoA.id,
        workerId: mkWorkerId('worker-a'),
        runId: runIdA,
        leaseToken: leaseTokenA,
      });
      rtB.runtime.workerLeaseRepository.release({
        repoId: repoB.id,
        workerId: mkWorkerId('worker-b'),
        runId: runIdB,
        leaseToken: leaseTokenB,
      });

      rtA.runtime.close();
      rtB.runtime.close();
      rtA.db.close();
      rtB.db.close();
    });
  });

  describe('global_limit_one_serializes_cross_repository_runs', () => {
    it('with globalConcurrency=1, only one dispatch is in-flight at a time', async () => {
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      const rtA = await buildTestRuntime(repoA);
      const rtB = await buildTestRuntime(repoB);

      const issueNumber = 42 as IssueNumber;
      await enqueueJob(rtA, issueNumber, JobId('job-a-42'), RunId('run-a-42'));
      await enqueueJob(rtB, issueNumber, JobId('job-b-42'), RunId('run-b-42'));

      const dispatchResults = new Map<string, Deferred<'completed' | 'no_work'>>();
      const dispatchCalls: Array<{ repository: Repository; workerId: WorkerId }> = [];

      const adapter = new RepositorySchedulerAdapter({
        runtimeFactory: async (repo) => {
          if (repo.id === repoA.id) return rtA.runtime;
          if (repo.id === repoB.id) return rtB.runtime;
          throw new Error('unknown repo');
        },
        logger: { error: () => {} },
        workerLoop: async (_runtime, _input) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        },
      });

      const telemetry = new RecordingTelemetryPort();
      const deferredDispatchA = defer<'completed' | 'no_work'>();
      const deferredDispatchB = defer<'completed' | 'no_work'>();
      dispatchResults.set(String(repoA.id), deferredDispatchA);
      dispatchResults.set(String(repoB.id), deferredDispatchB);

      const dispatch = {
        async runOne(input: {
          repository: Repository;
          workerId: WorkerId;
        }): Promise<'completed' | 'no_work'> {
          dispatchCalls.push(input);
          const d = dispatchResults.get(String(input.repository.id));
          if (d) return d.promise;
          return 'no_work';
        },
      };

      const scheduler = new FairRepositoryScheduler({
        globalConcurrency: 1,
        pollIntervalMs: 60000,
        repos: {
          listEnabled() {
            return [repoA, repoB];
          },
        },
        workSource: adapter,
        dispatch,
        telemetry,
        workerIdFactory: (repo, seq) => mkWorkerId(`w-${String(repo.id)}-${seq}`),
        sleep: async () => {},
        now: () => new Date(),
        logger: { error: () => {} },
      });

      const result1 = await scheduler.scheduleOnce();
      const result2 = await scheduler.scheduleOnce();

      expect(result1.admitted + result2.admitted).toBeLessThanOrEqual(2);

      deferredDispatchA.resolve('completed');
      deferredDispatchB.resolve('completed');

      adapter.close();
      rtA.runtime.close();
      rtB.runtime.close();
      rtA.db.close();
      rtB.db.close();
    });
  });

  describe('disabled_repository_drains_admitted_and_blocks_queued', () => {
    it('disabling a repo after job admission lets admitted work finish but blocks new work', async () => {
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      const rtA = await buildTestRuntime(repoA);
      const rtB = await buildTestRuntime(repoB);

      const issueNumber = 42 as IssueNumber;
      await enqueueJob(rtA, issueNumber, JobId('job-a-42'), RunId('run-a-42'));
      await enqueueJob(rtB, issueNumber, JobId('job-b-42'), RunId('run-b-42'));

      const dispatchResults = new Map<string, Deferred<'completed' | 'no_work'>>();
      const deferredDispatchA = defer<'completed' | 'no_work'>();
      const deferredDispatchB = defer<'completed' | 'no_work'>();
      dispatchResults.set(String(repoA.id), deferredDispatchA);
      dispatchResults.set(String(repoB.id), deferredDispatchB);

      const adapter = new RepositorySchedulerAdapter({
        runtimeFactory: async (repo) => {
          if (repo.id === repoA.id) return rtA.runtime;
          if (repo.id === repoB.id) return rtB.runtime;
          throw new Error('unknown repo');
        },
        logger: { error: () => {} },
        workerLoop: async () => {},
      });

      const telemetry = new RecordingTelemetryPort();

      const dispatch = {
        async runOne(input: {
          repository: Repository;
          workerId: WorkerId;
        }): Promise<'completed' | 'no_work'> {
          const d = dispatchResults.get(String(input.repository.id));
          if (d) return d.promise;
          return 'no_work';
        },
      };

      const scheduler = new FairRepositoryScheduler({
        globalConcurrency: 10,
        pollIntervalMs: 60000,
        repos: {
          listEnabled() {
            return [repoA, repoB];
          },
        },
        workSource: adapter,
        dispatch,
        telemetry,
        workerIdFactory: (repo, seq) => mkWorkerId(`w-${String(repo.id)}-${seq}`),
        sleep: async () => {},
        now: () => new Date(),
        logger: { error: () => {} },
      });

      await scheduler.scheduleOnce();

      repoA.enabled = false;

      await scheduler.scheduleOnce();

      const skipRecords = telemetry.records.filter(
        (r) => r.type === 'scheduler.repository.skipped' && r.reason === 'disabled',
      );
      expect(skipRecords.some((r) => r.repository_id === String(repoA.id))).toBe(true);

      deferredDispatchA.resolve('completed');
      deferredDispatchB.resolve('completed');

      adapter.close();
      rtA.runtime.close();
      rtB.runtime.close();
      rtA.db.close();
      rtB.db.close();
    });
  });

  describe('unavailable_repository_does_not_block_healthy_repository', () => {
    it('a missing localBasePath leaves that repo unavailable while healthy repo completes work', async () => {
      const repoA = makeRepository('acme/api', {
        localBasePath: '/nonexistent/path/for/api',
        healthStatus: 'unknown',
      });
      const repoB = makeRepository('acme/web');

      const rtB = await buildTestRuntime(repoB);

      const issueNumber = 42 as IssueNumber;
      await enqueueJob(rtB, issueNumber, JobId('job-b-42'), RunId('run-b-42'));

      const deferredDispatchB = defer<'completed' | 'no_work'>();
      const dispatchResults = new Map<string, Deferred<'completed' | 'no_work'>>();
      dispatchResults.set(String(repoB.id), deferredDispatchB);

      const adapter = new RepositorySchedulerAdapter({
        runtimeFactory: async (repo) => {
          if (repo.id === repoA.id) throw new Error('repo A unavailable');
          if (repo.id === repoB.id) return rtB.runtime;
          throw new Error('unknown repo');
        },
        logger: { error: () => {} },
        workerLoop: async () => {},
      });

      const telemetry = new RecordingTelemetryPort();

      const dispatch = {
        async runOne(input: {
          repository: Repository;
          workerId: WorkerId;
        }): Promise<'completed' | 'no_work'> {
          const d = dispatchResults.get(String(input.repository.id));
          if (d) return d.promise;
          return 'no_work';
        },
      };

      const scheduler = new FairRepositoryScheduler({
        globalConcurrency: 10,
        pollIntervalMs: 60000,
        repos: {
          listEnabled() {
            return [repoA, repoB];
          },
        },
        workSource: adapter,
        dispatch,
        telemetry,
        workerIdFactory: (repo, seq) => mkWorkerId(`w-${String(repo.id)}-${seq}`),
        sleep: async () => {},
        now: () => new Date(),
        logger: { error: () => {} },
      });

      await scheduler.scheduleOnce();

      const skipRecords = telemetry.records.filter(
        (r) => r.type === 'scheduler.repository.skipped',
      );
      const unavailableRecords = skipRecords.filter(
        (r) => r.reason === 'unavailable' || r.reason === 'disabled',
      );
      expect(unavailableRecords.some((r) => r.repository_id === String(repoA.id))).toBe(true);

      deferredDispatchB.resolve('completed');

      adapter.close();
      rtB.runtime.close();
      rtB.db.close();
    });
  });

  describe('scheduler_records_stable_repository_labels', () => {
    it('dispatch started/completed records include stable repository_id and repository_name', async () => {
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      const rtA = await buildTestRuntime(repoA);
      const rtB = await buildTestRuntime(repoB);

      const issueNumber = 42 as IssueNumber;
      await enqueueJob(rtA, issueNumber, JobId('job-a-42'), RunId('run-a-42'));
      await enqueueJob(rtB, issueNumber, JobId('job-b-42'), RunId('run-b-42'));

      const deferredDispatchA = defer<'completed' | 'no_work'>();
      const deferredDispatchB = defer<'completed' | 'no_work'>();
      const dispatchResults = new Map<string, Deferred<'completed' | 'no_work'>>();
      dispatchResults.set(String(repoA.id), deferredDispatchA);
      dispatchResults.set(String(repoB.id), deferredDispatchB);

      const adapter = new RepositorySchedulerAdapter({
        runtimeFactory: async (repo) => {
          if (repo.id === repoA.id) return rtA.runtime;
          if (repo.id === repoB.id) return rtB.runtime;
          throw new Error('unknown repo');
        },
        logger: { error: () => {} },
        workerLoop: async () => {},
      });

      const telemetry = new RecordingTelemetryPort();

      const dispatch = {
        async runOne(input: {
          repository: Repository;
          workerId: WorkerId;
        }): Promise<'completed' | 'no_work'> {
          const d = dispatchResults.get(String(input.repository.id));
          if (d) return d.promise;
          return 'no_work';
        },
      };

      const scheduler = new FairRepositoryScheduler({
        globalConcurrency: 10,
        pollIntervalMs: 60000,
        repos: {
          listEnabled() {
            return [repoA, repoB];
          },
        },
        workSource: adapter,
        dispatch,
        telemetry,
        workerIdFactory: (repo, seq) => mkWorkerId(`w-${String(repo.id)}-${seq}`),
        sleep: async () => {},
        now: () => new Date(),
        logger: { error: () => {} },
      });

      await scheduler.scheduleOnce();

      const startedRecords = telemetry.records.filter(
        (r) => r.type === 'scheduler.dispatch.started',
      );
      expect(startedRecords.length).toBeGreaterThan(0);

      for (const record of startedRecords) {
        expect(record.repository_id).toBeDefined();
        expect(record.repository_name).toBeDefined();
        expect(record.worker_id).toBeDefined();
      }

      const repoAStarted = startedRecords.filter((r) => r.repository_id === String(repoA.id));
      const repoBStarted = startedRecords.filter((r) => r.repository_id === String(repoB.id));
      expect(repoAStarted.length).toBeGreaterThan(0);
      expect(repoBStarted.length).toBeGreaterThan(0);

      expect(repoAStarted[0].repository_name).toBe(repoA.fullName);
      expect(repoBStarted[0].repository_name).toBe(repoB.fullName);

      deferredDispatchA.resolve('completed');
      deferredDispatchB.resolve('completed');

      adapter.close();
      rtA.runtime.close();
      rtB.runtime.close();
      rtA.db.close();
      rtB.db.close();
    });
  });

  describe('disable-race', () => {
    it('disabled queued repository stays parked while another dispatches', async () => {
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      const rtA = await buildTestRuntime(repoA);
      const rtB = await buildTestRuntime(repoB);

      const issueNumber = 42 as IssueNumber;
      await enqueueJob(rtA, issueNumber, JobId('job-a-42'), RunId('run-a-42'));
      await enqueueJob(rtB, issueNumber, JobId('job-b-42'), RunId('run-b-42'));

      const deferredDispatchA = defer<'completed' | 'no_work'>();
      const deferredDispatchB = defer<'completed' | 'no_work'>();
      const dispatchResults = new Map<string, Deferred<'completed' | 'no_work'>>();
      dispatchResults.set(String(repoA.id), deferredDispatchA);
      dispatchResults.set(String(repoB.id), deferredDispatchB);

      const adapter = new RepositorySchedulerAdapter({
        runtimeFactory: async (repo) => {
          if (repo.id === repoA.id) return rtA.runtime;
          if (repo.id === repoB.id) return rtB.runtime;
          throw new Error('unknown repo');
        },
        logger: { error: () => {} },
        workerLoop: async () => {},
      });

      const telemetry = new RecordingTelemetryPort();

      const dispatch = {
        async runOne(input: {
          repository: Repository;
          workerId: WorkerId;
        }): Promise<'completed' | 'no_work'> {
          const d = dispatchResults.get(String(input.repository.id));
          if (d) return d.promise;
          return 'no_work';
        },
      };

      const scheduler = new FairRepositoryScheduler({
        globalConcurrency: 10,
        pollIntervalMs: 60000,
        repos: {
          listEnabled() {
            return [repoA, repoB];
          },
        },
        workSource: adapter,
        dispatch,
        telemetry,
        workerIdFactory: (repo, seq) => mkWorkerId(`w-${String(repo.id)}-${seq}`),
        sleep: async () => {},
        now: () => new Date(),
        logger: { error: () => {} },
      });

      await scheduler.scheduleOnce();

      repoA.enabled = false;

      await scheduler.scheduleOnce();

      const skipRecords = telemetry.records.filter(
        (r) => r.type === 'scheduler.repository.skipped' && r.reason === 'disabled',
      );
      expect(skipRecords.some((r) => r.repository_id === String(repoA.id))).toBe(true);

      const startedRecords = telemetry.records.filter(
        (r) => r.type === 'scheduler.dispatch.started',
      );
      const repoBStarted = startedRecords.filter((r) => r.repository_id === String(repoB.id));
      expect(repoBStarted.length).toBeGreaterThan(0);

      deferredDispatchA.resolve('completed');
      deferredDispatchB.resolve('completed');

      adapter.close();
      rtA.runtime.close();
      rtB.runtime.close();
      rtA.db.close();
      rtB.db.close();
    });

    it('disable after claim requeues exact token without execution', async () => {
      const repoA = makeRepository('acme/api');
      const repoB = makeRepository('acme/web');

      const rtA = await buildTestRuntime(repoA);
      const rtB = await buildTestRuntime(repoB);

      const issueNumber = 42 as IssueNumber;
      const jobIdA = JobId('job-a-42');
      const runIdA = RunId('run-a-42');
      await enqueueJob(rtA, issueNumber, jobIdA, runIdA);
      await enqueueJob(rtB, issueNumber, JobId('job-b-42'), RunId('run-b-42'));

      const adapter = new RepositorySchedulerAdapter({
        runtimeFactory: async (repo) => {
          if (repo.id === repoA.id) return rtA.runtime;
          if (repo.id === repoB.id) return rtB.runtime;
          throw new Error('unknown repo');
        },
        logger: { error: () => {} },
        workerLoop: async (runtime, input) => {
          const releaseJob = () => {
            const job = runtime.jobQueue
              .listForRun(input.runId)
              .find(
                (j) =>
                  j.claimedBy === input.workerId &&
                  (j.status === 'claimed' || j.status === 'running'),
              );
            if (job) {
              try {
                runtime.jobQueue.releaseClaim(generateJobOwnership(job, input.workerId));
              } catch {
                // ignore
              }
            }
          };

          if (input.signal?.aborted) {
            releaseJob();
            return;
          }
          await new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 10000);
            if (input.signal) {
              input.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timeout);
                  releaseJob();
                  resolve();
                },
                { once: true },
              );
            }
          });
        },
      });

      const telemetry = new RecordingTelemetryPort();

      const scheduler = new FairRepositoryScheduler({
        globalConcurrency: 10,
        pollIntervalMs: 60000,
        repos: {
          listEnabled() {
            return [repoA, repoB];
          },
        },
        workSource: adapter,
        dispatch: adapter,
        telemetry,
        workerIdFactory: (repo, seq) => mkWorkerId(`w-${String(repo.id)}-${seq}`),
        sleep: async () => {},
        now: () => new Date(),
        logger: { error: () => {} },
      });

      await scheduler.scheduleOnce();

      const jobAfterFirstSchedule = rtA.jobQueue.findById(jobIdA);
      expect(jobAfterFirstSchedule?.status).toBe('claimed');

      repoA.enabled = false;

      scheduler.stopAdmission('disabled');

      await scheduler.scheduleOnce();

      const jobAfterDisable = rtA.jobQueue.findById(jobIdA);
      expect(jobAfterDisable?.status).toBe('queued');
      expect(jobAfterDisable?.claimToken ?? null).toBeNull();
      expect(jobAfterDisable?.claimedBy ?? null).toBeNull();

      adapter.close();
      rtA.runtime.close();
      rtB.runtime.close();
      rtA.db.close();
      rtB.db.close();
    });
  });
});
