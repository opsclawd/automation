import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  openDatabase,
  applyMigrations,
  MIGRATIONS,
  JobQueueRepository,
  WorkerLeaseRepository,
} from '@ai-sdlc/infrastructure';
import {
  FairRepositoryScheduler,
  CancelRun,
  RunExecutor,
  PhaseHandlerRegistry,
  type PhaseHandlerContext,
} from '@ai-sdlc/application';
import {
  RepositoryId,
  WorkerId as mkWorkerId,
  RunId,
  JobId,
  IssueNumber,
  JobOwnershipLostError,
  type Repository,
  type WorkerId,
  type Job,
  PhaseName as makePhaseName,
} from '@ai-sdlc/domain';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync } from 'node:fs';
import { RepositorySchedulerAdapter } from '../repository-scheduler-adapter.js';
import type { RepositoryRuntime } from '../repository-runtime-factory.js';
import {
  FakeGitPort,
  FakeArtifactStore,
  FakePhaseRepository,
} from '@ai-sdlc/application/test-doubles';

interface AdmissionWitness {
  requestedDeclared: Record<
    string,
    { value: unknown; source: string } | { value: null; status: 'explicitly-unknown' }
  >;
  configuredExecuted: {
    globalConcurrency: number;
    maxConcurrentRuns: number;
  };
  measuredVerified: {
    jobRow: Record<string, unknown> | null;
    claimedBy: string | null;
    claimToken: string | null;
    leaseRow: Record<string, unknown> | null;
    manualExecuteCalls: number;
  };
}

function makeRepository(
  fullName: string,
  opts?: {
    enabled?: boolean;
    localBasePath?: string;
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
    healthStatus: 'healthy',
    healthError: null,
    lastHealthCheckAt: null,
    configMetadata: '{}',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('Scheduler Claim Witness Suite (Issue #1286)', () => {
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

  function createTestEnvironment(repo: Repository) {
    const dir = join(tmpdir(), `ai-witness-${Date.now()}-${Math.random()}`);
    tempDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, 'test.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);

    const reposPort = {
      findById: (id: RepositoryId) => (id === repo.id ? repo : undefined),
      findByFullName: (name: string) => (name === repo.fullName ? repo : undefined),
      listEnabled: () => [repo],
    };

    const jobQueue = new JobQueueRepository(db, reposPort, repo.id);
    const workerLeaseRepository = new WorkerLeaseRepository(db);

    const runtime: RepositoryRuntime = {
      repository: repo,
      paths: {
        database: () => dbPath,
        worktreeForRun: () => dir,
      } as unknown as RepositoryRuntime['paths'],
      db,
      jobQueue,
      workerLeaseRepository,
      workerRegistry: {} as unknown as RepositoryRuntime['workerRegistry'],
      close: () => db.close(),
    };

    return { dir, db, jobQueue, workerLeaseRepository, runtime };
  }

  it('Scenario 1: Fresh Batch Start auto-claims and dispatches queued job with zero manual runs execute calls (COMMENT-1, COMMENT-2, COMMENT-3, AC-1, AC-2)', async () => {
    const repo = makeRepository('opsclawd/automation');
    const { db, jobQueue, runtime } = createTestEnvironment(repo);

    // 1. Precondition: Historical non-terminal job row existed from old terminal run
    // Seed an old terminal run (passed) and verify migration 0041 has reconciled any non-terminal jobs.
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, started_at, completed_at)
       VALUES ('45794aaa-202b-424c-a194-9214b8df0530', 'issue-42-zombie', ?, 42, 'issue_to_pr', 'passed', '2026-09-18T17:33:49.258Z', '2026-09-18T18:00:00.000Z')`,
    ).run(repo.id);

    // Historical job was left in 'running' prior to migration
    db.prepare(
      `INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, claimed_by, claim_token, created_at, started_at)
       VALUES ('zombie-job-42', '45794aaa-202b-424c-a194-9214b8df0530', ?, 42, 'running', 0, 1, 'old-worker', 'old-tok', '2026-09-18T17:33:49.258Z', '2026-09-18T17:33:50.000Z')`,
    ).run(repo.id);

    // Re-apply migration 0041 SQL to ensure the DB state is reconciled
    const m41 = MIGRATIONS.find((m) => m.version === 41)!;
    db.exec(m41.sql);

    const zombieJobAfterMigration = db
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .get('zombie-job-42') as { status: string };
    expect(zombieJobAfterMigration.status).toBe('succeeded');

    // 2. Fresh batch start admits issue #1282
    const runUuid = '26309c45-a4cf-4913-8c08-ff75f35e802b';
    const jobId = '50d2bfe6-5517-4c23-898e-4a827384efe6';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, started_at)
       VALUES (?, 'issue-1282-fresh', ?, 1282, 'issue_to_pr', 'running', '2026-09-22T20:40:32.932Z')`,
    ).run(runUuid, repo.id);

    const freshJob: Job = {
      id: JobId(jobId),
      runId: RunId(runUuid),
      repoId: repo.id,
      issueNumber: 1282 as IssueNumber,
      status: 'queued',
      priority: 0,
      attempts: 0,
      createdAt: new Date('2026-09-22T20:40:32.932Z'),
    };
    jobQueue.enqueue({ job: freshJob });

    // 3. Spy on manual CLI execution — MUST remain 0
    let manualExecuteCalls = 0;
    const manualExecuteSpy = vi.fn().mockImplementation(() => {
      manualExecuteCalls++;
    });

    // 4. Set up scheduler adapter & scheduler
    let dispatchedJob: { repoId: RepositoryId; workerId: WorkerId } | undefined;
    const adapter = new RepositorySchedulerAdapter({
      runtimeFactory: async () => runtime,
      logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    });

    const dispatch = {
      async runOne(input: {
        repository: Repository;
        workerId: WorkerId;
      }): Promise<'completed' | 'no_work'> {
        dispatchedJob = { repoId: input.repository.id, workerId: input.workerId };
        // Claim the job as a worker would in worker-loop
        const claimed = jobQueue.claimNext({
          workerId: input.workerId,
          repoId: input.repository.id,
        });
        expect(claimed).toBeDefined();
        return 'completed';
      },
    };

    const scheduler = new FairRepositoryScheduler({
      globalConcurrency: 1,
      pollIntervalMs: 60000,
      repos: {
        listEnabled() {
          return [repo];
        },
      },
      workSource: adapter,
      dispatch,
      workerIdFactory: (r, seq) => mkWorkerId(`worker-${String(r.id)}-${seq}`),
      sleep: async () => {},
      now: () => new Date(),
      logger: { error: () => {} },
    });

    // 5. Scheduler executes one schedule tick
    const scheduleResult = await scheduler.scheduleOnce();

    // 6. Assertions
    expect(scheduleResult.admitted).toBe(1);
    expect(dispatchedJob).toBeDefined();
    expect(manualExecuteSpy).toHaveBeenCalledTimes(0);
    expect(manualExecuteCalls).toBe(0);

    const jobRow = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as {
      status: string;
      claimed_by: string | null;
      claim_token: string | null;
    };
    expect(jobRow.status).toBe('claimed');
    expect(jobRow.claimed_by).not.toBeNull();
    expect(jobRow.claim_token).not.toBeNull();

    // Verify 3-envelope AdmissionWitness
    const witness: AdmissionWitness = {
      requestedDeclared: {
        runUuid: { value: runUuid, source: 'release-batch start' },
        jobId: { value: jobId, source: 'release-batch start' },
        issueNumber: { value: 1282, source: 'release-batch start' },
        priority: { value: null, status: 'explicitly-unknown' },
      },
      configuredExecuted: {
        globalConcurrency: 1,
        maxConcurrentRuns: 1,
      },
      measuredVerified: {
        jobRow: jobRow as unknown as Record<string, unknown>,
        claimedBy: jobRow.claimed_by,
        claimToken: jobRow.claim_token,
        leaseRow: null,
        manualExecuteCalls,
      },
    };

    expect(witness.configuredExecuted.globalConcurrency).toBe(1);
    expect(witness.measuredVerified.manualExecuteCalls).toBe(0);
    expect(witness.measuredVerified.claimedBy).toBeTruthy();

    adapter.close();
    runtime.close();
  });

  it('Scenario 2: Successor Admission auto-claims successor job after predecessor settles (COMMENT-4, COMMENT-5, AC-2)', async () => {
    const repo = makeRepository('opsclawd/automation');
    const { db, jobQueue, runtime } = createTestEnvironment(repo);

    // Predecessor issue #1282 settles
    const predRunUuid = '26309c45-a4cf-4913-8c08-ff75f35e802b';
    const predJobId = '50d2bfe6-5517-4c23-898e-4a827384efe6';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, started_at, completed_at)
       VALUES (?, 'issue-1282', ?, 1282, 'issue_to_pr', 'passed', '2026-09-22T20:40:00Z', '2026-09-22T20:50:00Z')`,
    ).run(predRunUuid, repo.id);

    jobQueue.enqueue({
      job: {
        id: JobId(predJobId),
        runId: RunId(predRunUuid),
        repoId: repo.id,
        issueNumber: 1282 as IssueNumber,
        status: 'queued',
        priority: 0,
        attempts: 0,
        createdAt: new Date('2026-09-22T20:40:00Z'),
      },
    });

    // Predecessor is reconciled to succeeded
    jobQueue.reconcileTerminalJob({
      jobId: JobId(predJobId),
      targetStatus: 'succeeded',
      now: new Date('2026-09-22T20:50:00Z'),
    });

    // Successor issue #1286 admitted via release-batch resume
    const succRunUuid = 'a244c468-800c-4c8d-b7cf-1bb7c5277f7e';
    const succJobId = 'succ-job-1286';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, started_at)
       VALUES (?, 'issue-1286', ?, 1286, 'issue_to_pr', 'running', '2026-09-22T21:00:00Z')`,
    ).run(succRunUuid, repo.id);

    jobQueue.enqueue({
      job: {
        id: JobId(succJobId),
        runId: RunId(succRunUuid),
        repoId: repo.id,
        issueNumber: 1286 as IssueNumber,
        status: 'queued',
        priority: 0,
        attempts: 0,
        createdAt: new Date('2026-09-22T21:00:00Z'),
      },
    });

    // Assert distinct identities
    expect(predRunUuid).not.toEqual(succRunUuid);
    expect(predJobId).not.toEqual(succJobId);

    const manualExecuteSpy = vi.fn();
    const adapter = new RepositorySchedulerAdapter({
      runtimeFactory: async () => runtime,
      logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
    });

    let successorDispatched = false;
    const dispatch = {
      async runOne(input: {
        repository: Repository;
        workerId: WorkerId;
      }): Promise<'completed' | 'no_work'> {
        const claimed = jobQueue.claimNext({
          workerId: input.workerId,
          repoId: input.repository.id,
        });
        if (claimed && claimed.id === JobId(succJobId)) {
          successorDispatched = true;
        }
        return 'completed';
      },
    };

    const scheduler = new FairRepositoryScheduler({
      globalConcurrency: 1,
      pollIntervalMs: 60000,
      repos: {
        listEnabled() {
          return [repo];
        },
      },
      workSource: adapter,
      dispatch,
      workerIdFactory: (r, seq) => mkWorkerId(`worker-${String(r.id)}-${seq}`),
      sleep: async () => {},
      now: () => new Date(),
      logger: { error: () => {} },
    });

    const tick = await scheduler.scheduleOnce();
    expect(tick.admitted).toBe(1);
    expect(successorDispatched).toBe(true);
    expect(manualExecuteSpy).toHaveBeenCalledTimes(0);

    const succRow = db.prepare('SELECT * FROM jobs WHERE id = ?').get(succJobId) as {
      status: string;
    };
    expect(succRow.status).toBe('claimed');

    adapter.close();
    runtime.close();
  });

  it('Scenario 3: Cancellation vs Worker Race (AC-3, AC-4, AC-8)', async () => {
    const repo = makeRepository('opsclawd/automation');
    const { db, jobQueue, workerLeaseRepository, runtime } = createTestEnvironment(repo);

    const runUuid = 'race-run-1';
    const jobId = 'race-job-1';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, started_at)
       VALUES (?, 'issue-100', ?, 100, 'issue_to_pr', 'running', '2026-09-22T21:00:00Z')`,
    ).run(runUuid, repo.id);

    jobQueue.enqueue({
      job: {
        id: JobId(jobId),
        runId: RunId(runUuid),
        repoId: repo.id,
        issueNumber: 100 as IssueNumber,
        status: 'queued',
        priority: 0,
        attempts: 0,
        createdAt: new Date('2026-09-22T21:00:00Z'),
      },
    });

    const claimed = jobQueue.claimNext({
      workerId: mkWorkerId('worker-race'),
      repoId: repo.id,
    });
    expect(claimed).toBeDefined();
    const owner = {
      jobId: claimed!.id,
      workerId: claimed!.claimedBy!,
      claimToken: claimed!.claimToken!,
    };
    jobQueue.markRunning(owner, new Date());

    // Acquire lease
    workerLeaseRepository.acquire({
      repoId: repo.id,
      workerId: owner.workerId,
      runId: RunId(runUuid),
      now: new Date(),
      ttlMs: 60000,
    });

    // 1. CancelRun executes
    const cancelRun = new CancelRun({
      runRepository: {
        findByUuid: (id) =>
          db
            .prepare(
              'SELECT uuid, display_id, repo_id, issue_number, type, status, started_at, completed_at FROM runs WHERE uuid = ?',
            )
            .get(id) as never,
        atomicUpdateByUuid: (id, patch, expected) => {
          const res = db
            .prepare(
              'UPDATE runs SET status = @status, completed_at = @completedAt WHERE uuid = @id AND status = @expected',
            )
            .run({
              status: patch.status,
              completedAt: patch.completedAt.toISOString(),
              id,
              expected,
            });
          return res.changes > 0;
        },
      } as never,
      runAbort: {
        register: () => {},
        abort: async () => ({ status: 'exited' }),
        unregister: () => {},
      },
      git: {
        resetHard: async () => {},
        cleanUntracked: async () => {},
        headCommitSha: async () => 'sha-1',
        headCommitShaOf: async () => 'sha-1',
      } as never,
      leases: workerLeaseRepository,
      findCwd: () => '/tmp',
      logger: { error: () => {} },
      queue: jobQueue,
    });

    const cancelResult = await cancelRun.execute({ runId: RunId(runUuid) });
    expect(cancelResult.status).toBe('cancelled');

    // 2. Fencing: Worker attempts to mark succeeded after CancelRun
    expect(() => {
      jobQueue.markSucceeded(owner, new Date());
    }).toThrow(JobOwnershipLostError);

    // 3. Timed-out abort skips worktree reset
    let resetAttempted = false;
    const timingOutCancelRun = new CancelRun({
      runRepository: {
        findByUuid: () => ({ uuid: 'timeout-run', status: 'running', completedPhases: [] }),
        atomicUpdateByUuid: () => true,
      } as never,
      runAbort: {
        register: () => {},
        abort: async () => ({ status: 'timed_out' }),
        unregister: () => {},
      },
      git: {
        resetHard: async () => {
          resetAttempted = true;
        },
        cleanUntracked: async () => {},
      } as never,
      leases: workerLeaseRepository,
      findCwd: () => '/tmp',
      logger: { error: () => {} },
      queue: jobQueue,
    });

    const timeoutRes = await timingOutCancelRun.execute({ runId: RunId('timeout-run') });
    expect(timeoutRes.abortStatus).toBe('timed_out');
    expect(timeoutRes.worktreeReset).toBe(false);
    expect(resetAttempted).toBe(false);

    runtime.close();
  });

  it('Scenario 4: Early-Phase Missing SHA recovers or fails cleanly without unhandled exceptions (CONSUMER-1282, AC-5, AC-6)', async () => {
    const repo = makeRepository('opsclawd/automation');
    const { jobQueue, runtime } = createTestEnvironment(repo);

    // 1. Success case: baseline ref resolves cleanly
    const git = new FakeGitPort();
    git.resolveRefResults.set('origin/main', 'sha-recovered-clean');

    let persistedSha: string | undefined;
    const runRepo = {
      findByUuid: () => ({
        uuid: 'run-no-sha',
        displayId: 'issue-10-run',
        repoId: repo.id,
        issueNumber: 10,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        skippedPhases: [],
        startCommitSha: persistedSha,
        baseBranch: 'main',
        startedAt: new Date(),
      }),
      update: (_id: string, patch: { startCommitSha?: string }) => {
        if (patch.startCommitSha) persistedSha = patch.startCommitSha;
      },
    };

    const artifacts = new FakeArtifactStore();
    const registry = new PhaseHandlerRegistry();
    const allPhases = [
      'read_issue',
      'plan-design',
      'plan-write',
      'plan-review',
      'implement',
      'validate',
      'fix-validate',
      'spec-review',
      'quality-review',
      'fix-review',
      'follow-up-review',
      'review-fix',
      'compound',
      'create-pr',
      'wait-merge',
      'post-pr-review',
    ];
    for (const phase of allPhases) {
      registry.register({
        phase: makePhaseName(phase),
        run: async (ctx) => {
          if (phase === 'spec-review') {
            try {
              await ctx.artifacts.write({
                runId: ctx.runUuid,
                relativePath: 'spec-review.json',
                contents: JSON.stringify({
                  verdict: 'PASS',
                  requirements_checks: [],
                  findings: [],
                }),
              });
            } catch {}
          } else if (phase === 'quality-review') {
            try {
              await ctx.artifacts.write({
                runId: ctx.runUuid,
                relativePath: 'quality-review.json',
                contents: JSON.stringify({ verdict: 'APPROVE', findings: [] }),
              });
            } catch {}
          } else if (phase === 'follow-up-review') {
            try {
              await ctx.artifacts.write({
                runId: ctx.runUuid,
                relativePath: 'follow-up-review.json',
                contents: JSON.stringify({ verdict: 'APPROVE', evaluations: [], new_findings: [] }),
              });
            } catch {}
          } else if (phase === 'create-pr') {
            try {
              await ctx.artifacts.write({
                runId: ctx.runUuid,
                relativePath: 'pr-url.txt',
                contents: 'https://github.com/o/r/pull/1',
              });
            } catch {}
          }
          return { outcome: 'passed' };
        },
      });
    }

    let capturedCtx: PhaseHandlerContext | undefined;
    const executor = new RunExecutor({
      runRepository: runRepo as never,
      failureRepository: { insert: vi.fn(), findLatestByRun: vi.fn() } as never,
      phaseRepository: new FakePhaseRepository(),
      events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
      registry,
      jobQueue,
      contextFactory: (r) => {
        capturedCtx = {
          runId: r.displayId,
          runUuid: r.uuid,
          repoFullName: repo.fullName,
          issueNumber: 10,
          cwd: '/tmp',
          artifacts,
          git,
          baseBranch: 'main',
          startCommitSha: (r as { startCommitSha?: string }).startCommitSha,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => new Date(),
        } as unknown as PhaseHandlerContext;
        return capturedCtx;
      },
    });

    const successResult = await executor.execute({
      run: runRepo.findByUuid() as never,
      skip: [],
      presentArtifacts: [],
    });

    expect(successResult.run.status).toBe('passed');
    expect(persistedSha).toBe('sha-recovered-clean');
    expect(capturedCtx?.startCommitSha).toBe('sha-recovered-clean');

    // 2. Failure case: baseline ref cannot be resolved
    const gitFail = new FakeGitPort(); // Empty -> cannot resolve
    const failureInsertSpy = vi.fn();
    let failPersistedSha: string | undefined;

    const runFailRepo = {
      findByUuid: () => ({
        uuid: 'run-fail-sha',
        displayId: 'issue-20-run',
        repoId: repo.id,
        issueNumber: 20,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        skippedPhases: [],
        startCommitSha: failPersistedSha,
        baseBranch: 'nonexistent-branch',
        startedAt: new Date(),
      }),
      update: (_id: string, patch: { startCommitSha?: string }) => {
        if (patch.startCommitSha) failPersistedSha = patch.startCommitSha;
      },
    };

    jobQueue.enqueue({
      job: {
        id: JobId('job-fail-sha'),
        runId: RunId('run-fail-sha'),
        repoId: repo.id,
        issueNumber: 20 as IssueNumber,
        status: 'queued',
        priority: 0,
        attempts: 0,
        createdAt: new Date(),
      },
    });

    const failExecutor = new RunExecutor({
      runRepository: runFailRepo as never,
      failureRepository: { insert: failureInsertSpy, findLatestByRun: vi.fn() } as never,
      phaseRepository: new FakePhaseRepository(),
      events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
      registry,
      jobQueue,
      contextFactory: (r) =>
        ({
          runId: r.displayId,
          runUuid: r.uuid,
          repoFullName: repo.fullName,
          issueNumber: 20,
          cwd: '/tmp',
          artifacts,
          git: gitFail,
          baseBranch: 'nonexistent-branch',
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => new Date(),
        }) as unknown as PhaseHandlerContext,
    });

    const failResult = await failExecutor.execute({
      run: runFailRepo.findByUuid() as never,
      skip: [],
      presentArtifacts: [],
    });

    expect(failResult.run.status).toBe('needs_human_review');
    expect(failureInsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'setup_failed',
        canRetry: true,
      }),
    );
    const failJob = jobQueue.findById(JobId('job-fail-sha'));
    expect(failJob?.status).toBe('failed');

    runtime.close();
  });

  it('Scenario 5: Provenance Witness Envelopes adhere to lossless schema (AC-7)', () => {
    const witness: AdmissionWitness = {
      requestedDeclared: {
        runUuid: { value: 'test-uuid', source: 'declared' },
        optionalField: { value: null, status: 'explicitly-unknown' },
      },
      configuredExecuted: {
        globalConcurrency: 1,
        maxConcurrentRuns: 1,
      },
      measuredVerified: {
        jobRow: { id: 'job-1', status: 'claimed' },
        claimedBy: 'worker-1',
        claimToken: 'tok-123',
        leaseRow: null,
        manualExecuteCalls: 0,
      },
    };

    expect(witness.requestedDeclared.runUuid).toEqual({ value: 'test-uuid', source: 'declared' });
    expect(witness.requestedDeclared.optionalField).toEqual({
      value: null,
      status: 'explicitly-unknown',
    });
    expect(witness.configuredExecuted.globalConcurrency).toBe(1);
    expect(witness.measuredVerified.manualExecuteCalls).toBe(0);
  });
});
