import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RepositoryId, WorkerId, RunId, JobId, IssueNumber, createWorker } from '@ai-sdlc/domain';
import type { Repository } from '@ai-sdlc/domain';
import {
  FakeJobQueuePort,
  FakeWorkerLeasePort,
  FakeWorkerRegistryPort,
  FakeRepositoryPort,
  FakeRunRepository,
  FakeGitHubPort,
  FakeEventBus,
} from '@ai-sdlc/application/test-doubles';
import { createJob } from '@ai-sdlc/domain';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';

function makeRepository(fullName: string, enabled = true): Repository {
  const [owner, name] = fullName.split('/');
  return {
    id: RepositoryId(fullName),
    owner,
    name,
    fullName,
    defaultBranch: 'main',
    remoteUrl: `git@github.com:${fullName}.git`,
    localBasePath: `/tmp/repos/${fullName}`,
    enabled,
    maxConcurrentRuns: 1 as const,
    healthStatus: 'healthy',
    healthError: null,
    lastHealthCheckAt: null,
    configMetadata: '{}',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeWorkerLeasePort(registry: FakeWorkerRegistryPort): FakeWorkerLeasePort & {
  _leases: Map<string, { repoId: string; workerId: string; runId: string; expiresAt: Date }>;
} {
  return new FakeWorkerLeasePort(registry) as FakeWorkerLeasePort & {
    _leases: Map<string, { repoId: string; workerId: string; runId: string; expiresAt: Date }>;
  };
}

const tempDirs: string[] = [];

function trackDir(fn: () => string): string {
  const dir = fn();
  tempDirs.push(dir);
  return dir;
}

function makeScriptPath(dir: string): string {
  const scriptPath = join(dir, 'run.sh');
  writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\nexit 0\n');
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

interface RepositoryContainer {
  repo: Repository;
  repos: FakeRepositoryPort;
  queue: FakeJobQueuePort;
  runRepo: FakeRunRepository;
  registry: FakeWorkerRegistryPort;
  leases: ReturnType<typeof makeWorkerLeasePort>;
  gh: FakeGitHubPort;
  eventBus: FakeEventBus;
  scriptPath: string;
  baseTmpDir: string;
  runsDir: string;
}

function createContainer(fullName: string): RepositoryContainer {
  const repo = makeRepository(fullName);
  const repos = new FakeRepositoryPort([repo]);
  const queue = new FakeJobQueuePort(repos);
  const runRepo = new FakeRunRepository();
  const registry = new FakeWorkerRegistryPort();
  const leases = makeWorkerLeasePort(registry);
  const gh = new FakeGitHubPort();
  const eventBus = new FakeEventBus();

  const dir = trackDir(() =>
    mkdtempSync(join(tmpdir(), `repo-iso-${fullName.replace('/', '-')}-`)),
  );
  const scriptPath = makeScriptPath(dir);

  return {
    repo,
    repos,
    queue,
    runRepo,
    registry,
    leases,
    gh,
    eventBus,
    scriptPath,
    baseTmpDir: dir,
    runsDir: join(dir, '.ai-runs'),
  };
}

describe('repository-runtime-recovery', () => {
  describe('behavioral invariant: recovery_is_limited_to_owning_runtime', () => {
    let containerA: RepositoryContainer;
    let containerB: RepositoryContainer;
    const issueNumber = 42 as IssueNumber;

    beforeEach(() => {
      containerA = createContainer('owner/api-repo');
      containerB = createContainer('owner/web-repo');

      const now = new Date();

      const jobA = createJob({
        id: JobId('job-a-42'),
        runId: RunId('run-a-42'),
        repoId: containerA.repo.id,
        issueNumber,
        createdAt: now,
      });
      const jobB = createJob({
        id: JobId('job-b-42'),
        runId: RunId('run-b-42'),
        repoId: containerB.repo.id,
        issueNumber,
        createdAt: now,
      });

      containerA.queue.enqueue({ job: jobA });
      containerB.queue.enqueue({ job: jobB });
    });

    afterEach(() => {
      while (tempDirs.length) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
      }
    });

    describe('cancellation resets only the owning repository worktree', () => {
      it('cancelling repo A does not affect repo B job status', () => {
        const workerIdA = WorkerId('worker-a');
        const workerIdB = WorkerId('worker-b');
        const runIdA = RunId('run-a-42');
        const runIdB = RunId('run-b-42');
        const now = new Date();

        const leaseA = containerA.leases.acquire({
          repoId: containerA.repo.id,
          workerId: workerIdA,
          runId: runIdA,
          now,
          ttlMs: 60000,
        });
        const leaseB = containerB.leases.acquire({
          repoId: containerB.repo.id,
          workerId: workerIdB,
          runId: runIdB,
          now,
          ttlMs: 60000,
        });

        expect(leaseA.repoId).toBe(containerA.repo.id);
        expect(leaseB.repoId).toBe(containerB.repo.id);

        const claimedA = containerA.queue.claimNext({
          repoId: containerA.repo.id,
          workerId: workerIdA,
          ttlMs: 60000,
        });
        const claimedB = containerB.queue.claimNext({
          repoId: containerB.repo.id,
          workerId: workerIdB,
          ttlMs: 60000,
        });

        expect(claimedA?.id).toBeDefined();
        expect(claimedB?.id).toBeDefined();

        containerA.queue.markRunning(claimedA!.id, now);

        expect(containerA.queue.findById(claimedA!.id)?.status).toBe('running');
        expect(containerB.queue.findById(claimedB!.id)?.status).toBe('claimed');

        containerA.queue.markCancelled(claimedA!.id, new Date());

        expect(containerA.queue.findById(claimedA!.id)?.status).toBe('cancelled');
        expect(containerB.queue.findById(claimedB!.id)?.status).toBe('claimed');
        expect(containerB.queue.findById(claimedB!.id)?.status).not.toBe('cancelled');
      });

      it('cancelling repo A does not affect repo B lease', () => {
        const workerIdA = WorkerId('worker-a');
        const workerIdB = WorkerId('worker-b');
        const runIdA = RunId('run-a-42');
        const runIdB = RunId('run-b-42');
        const now = new Date();

        const leaseA = containerA.leases.acquire({
          repoId: containerA.repo.id,
          workerId: workerIdA,
          runId: runIdA,
          now,
          ttlMs: 60000,
        });
        const leaseB = containerB.leases.acquire({
          repoId: containerB.repo.id,
          workerId: workerIdB,
          runId: runIdB,
          now,
          ttlMs: 60000,
        });

        expect(leaseA.repoId).toBe(containerA.repo.id);
        expect(leaseB.repoId).toBe(containerB.repo.id);

        containerA.leases.release({
          repoId: containerA.repo.id,
          workerId: workerIdA,
          runId: runIdA,
          leaseToken: leaseA.leaseToken,
        });

        expect(containerA.leases.current(containerA.repo.id)).toBeUndefined();
        expect(containerB.leases.current(containerB.repo.id)?.repoId).toBe(containerB.repo.id);
      });

      it('cancelling repo A does not affect repo B events', () => {
        const runIdA = RunId('run-a-42');
        const runIdB = RunId('run-b-42');
        const now = new Date();

        containerA.eventBus.publish(runIdA, {
          runId: 'run-a-42',
          level: 'info',
          type: 'run.started',
          message: 'started A',
          timestamp: now.toISOString(),
          metadata: { repoId: containerA.repo.id },
        });

        containerB.eventBus.publish(runIdB, {
          runId: 'run-b-42',
          level: 'info',
          type: 'run.started',
          message: 'started B',
          timestamp: now.toISOString(),
          metadata: { repoId: containerB.repo.id },
        });

        const eventsBeforeA = (containerA.eventBus as FakeEventBus).published.length;
        const eventsBeforeB = (containerB.eventBus as FakeEventBus).published.length;

        containerA.eventBus.publish(runIdA, {
          runId: 'run-a-42',
          level: 'info',
          type: 'run.cancelled',
          message: 'cancelled A',
          timestamp: new Date(now.getTime() + 1000).toISOString(),
          metadata: { repoId: containerA.repo.id },
        });

        const eventsAfterA = (containerA.eventBus as FakeEventBus).published.length;
        const eventsAfterB = (containerB.eventBus as FakeEventBus).published.length;

        expect(eventsAfterA).toBeGreaterThan(eventsBeforeA);
        expect(eventsAfterB).toBe(eventsBeforeB);

        const allEventsB = (containerB.eventBus as FakeEventBus).published;
        expect(allEventsB.some((e) => e.type === 'run.cancelled')).toBe(false);
        expect(allEventsB.every((e) => e.event.metadata?.repoId === containerB.repo.id)).toBe(true);
      });

      it('cancelling repo A does not affect repo B worktree paths', () => {
        const worktreePathA = join(containerA.baseTmpDir, 'worktrees', `issue-${issueNumber}`);
        const worktreePathB = join(containerB.baseTmpDir, 'worktrees', `issue-${issueNumber}`);

        expect(worktreePathA).not.toBe(worktreePathB);
        expect(worktreePathA).toContain(containerA.baseTmpDir);
        expect(worktreePathB).toContain(containerB.baseTmpDir);
        expect(worktreePathA).not.toContain(containerB.baseTmpDir);
        expect(worktreePathB).not.toContain(containerA.baseTmpDir);
      });
    });

    describe('expired lease recovery requeues and resets only the selected runtime', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('reclaiming expired lease on repo A does not affect repo B job', () => {
        const workerIdA = WorkerId('worker-a');
        const workerIdB = WorkerId('worker-b');
        const runIdA = RunId('run-a-42');
        const runIdB = RunId('run-b-42');
        const now = new Date();

        const _leaseA = containerA.leases.acquire({
          repoId: containerA.repo.id,
          workerId: workerIdA,
          runId: runIdA,
          now,
          ttlMs: 60000,
        });
        const _leaseB = containerB.leases.acquire({
          repoId: containerB.repo.id,
          workerId: workerIdB,
          runId: runIdB,
          now,
          ttlMs: 60000,
        });

        const claimedA = containerA.queue.claimNext({
          repoId: containerA.repo.id,
          workerId: workerIdA,
          ttlMs: 60000,
        });
        const claimedB = containerB.queue.claimNext({
          repoId: containerB.repo.id,
          workerId: workerIdB,
          ttlMs: 60000,
        });

        expect(claimedA?.id).toBeDefined();
        expect(claimedB?.id).toBeDefined();

        containerA.queue.markRunning(claimedA!.id, now);

        containerA.registry.register(
          createWorker({
            id: workerIdA,
            repoId: containerA.repo.id,
            hostname: 'test-host',
            processId: 1,
            now,
          }),
        );
        containerB.registry.register(
          createWorker({
            id: workerIdB,
            repoId: containerB.repo.id,
            hostname: 'test-host',
            processId: 2,
            now,
          }),
        );

        const expiredTime = new Date(now.getTime() + 120_000);
        vi.setSystemTime(expiredTime);

        containerA.registry.markStopping(workerIdA, containerA.repo.id);

        const reclaimedA = containerA.leases.reclaimExpired({
          now: expiredTime,
          recoverableRunIds: new Set([runIdA]),
          isWorkerAlive: (wid) => wid !== workerIdA,
          resetWorktree: (repoId) => {
            expect(repoId).toBe(containerA.repo.id);
          },
          onReclaimed: ({ repoId, previousWorkerId, previousRunId, reclaimedByWorkerId }) => {
            expect(repoId).toBe(containerA.repo.id);
            expect(previousWorkerId).toBe(workerIdA);
            expect(previousRunId).toBe(runIdA);
            expect(reclaimedByWorkerId).toBe(WorkerId('reclaimer'));
          },
          reclaimedByWorkerId: WorkerId('reclaimer'),
        });

        expect(reclaimedA).toHaveLength(1);
        expect(reclaimedA[0]?.repoId).toBe(containerA.repo.id);
        expect(reclaimedA[0]?.workerId).toBe(workerIdA);
        expect(reclaimedA[0]?.runId).toBe(runIdA);

        expect(containerB.queue.findById(claimedB!.id)?.status).toBe('claimed');
        expect(containerB.queue.findById(claimedB!.id)?.status).not.toBe('queued');

        expect(containerB.leases.current(containerB.repo.id)?.repoId).toBe(containerB.repo.id);
      });

      it('reclaiming expired lease on repo A resets only repo A job to queued', () => {
        const workerIdA = WorkerId('worker-a');
        const workerIdB = WorkerId('worker-b');
        const runIdA = RunId('run-a-42');
        const runIdB = RunId('run-b-42');
        const now = new Date();

        const _leaseA = containerA.leases.acquire({
          repoId: containerA.repo.id,
          workerId: workerIdA,
          runId: runIdA,
          now,
          ttlMs: 60000,
        });
        const _leaseB = containerB.leases.acquire({
          repoId: containerB.repo.id,
          workerId: workerIdB,
          runId: runIdB,
          now,
          ttlMs: 60000,
        });

        const claimedA = containerA.queue.claimNext({
          repoId: containerA.repo.id,
          workerId: workerIdA,
          ttlMs: 60000,
        });
        const claimedB = containerB.queue.claimNext({
          repoId: containerB.repo.id,
          workerId: workerIdB,
          ttlMs: 60000,
        });

        containerA.queue.markRunning(claimedA!.id, now);

        containerA.registry.register(
          createWorker({
            id: workerIdA,
            repoId: containerA.repo.id,
            hostname: 'test-host',
            processId: 1,
            now,
          }),
        );
        containerB.registry.register(
          createWorker({
            id: workerIdB,
            repoId: containerB.repo.id,
            hostname: 'test-host',
            processId: 2,
            now,
          }),
        );

        const expiredTime = new Date(now.getTime() + 120_000);
        vi.setSystemTime(expiredTime);

        containerA.registry.markStopping(workerIdA, containerA.repo.id);

        const reclaimedA = containerA.leases.reclaimExpired({
          now: expiredTime,
          recoverableRunIds: new Set([runIdA]),
          isWorkerAlive: (wid) => wid !== workerIdA,
          resetWorktree: (_repoId) => {},
          onReclaimed: (info) => {
            if (info.repoId !== containerA.repo.id) return;
            const jobs = containerA.queue.listForRun(info.previousRunId);
            for (const job of jobs) {
              if (job.status === 'claimed' || job.status === 'running') {
                containerA.queue.resetToQueued(job.id);
              }
            }
          },
          reclaimedByWorkerId: WorkerId('reclaimer'),
        });

        expect(reclaimedA).toHaveLength(1);

        expect(containerA.queue.findById(claimedA!.id)?.status).toBe('queued');
        expect(containerB.queue.findById(claimedB!.id)?.status).toBe('claimed');
        expect(containerB.queue.findById(claimedB!.id)?.status).not.toBe('queued');
      });

      it('stale-release race: repo B continues normally while repo A is being reaped', async () => {
        const workerIdA = WorkerId('worker-a');
        const workerIdB = WorkerId('worker-b');
        const runIdA = RunId('run-a-42');
        const runIdB = RunId('run-b-42');
        const now = new Date();

        const _leaseA = containerA.leases.acquire({
          repoId: containerA.repo.id,
          workerId: workerIdA,
          runId: runIdA,
          now,
          ttlMs: 60000,
        });
        const leaseB = containerB.leases.acquire({
          repoId: containerB.repo.id,
          workerId: workerIdB,
          runId: runIdB,
          now,
          ttlMs: 60000,
        });

        const claimedA = containerA.queue.claimNext({
          repoId: containerA.repo.id,
          workerId: workerIdA,
          ttlMs: 60000,
        });
        const claimedB = containerB.queue.claimNext({
          repoId: containerB.repo.id,
          workerId: workerIdB,
          ttlMs: 60000,
        });

        containerA.queue.markRunning(claimedA!.id, now);
        containerB.queue.markRunning(claimedB!.id, now);

        containerA.registry.register(
          createWorker({
            id: workerIdA,
            repoId: containerA.repo.id,
            hostname: 'test-host',
            processId: 1,
            now,
          }),
        );
        containerB.registry.register(
          createWorker({
            id: workerIdB,
            repoId: containerB.repo.id,
            hostname: 'test-host',
            processId: 2,
            now,
          }),
        );

        const expiredTime = new Date(now.getTime() + 120_000);
        vi.setSystemTime(expiredTime);

        containerA.registry.markStopping(workerIdA, containerA.repo.id);

        const reclaimPromise = (async () => {
          return containerA.leases.reclaimExpired({
            now: expiredTime,
            recoverableRunIds: new Set([runIdA]),
            isWorkerAlive: (wid) => wid !== workerIdA,
            resetWorktree: (_repoId) => {},
            onReclaimed: (_info) => {},
            reclaimedByWorkerId: WorkerId('reclaimer'),
          });
        })();

        containerB.leases.heartbeat({
          repoId: containerB.repo.id,
          workerId: workerIdB,
          runId: runIdB,
          now: expiredTime,
          newExpiresAt: new Date(expiredTime.getTime() + 60000),
          leaseToken: leaseB.leaseToken,
        });

        const reclaimedA = await reclaimPromise;

        expect(reclaimedA).toHaveLength(1);
        expect(containerB.leases.checkActiveLease(containerB.repo.id, expiredTime)).toBe(true);
        expect(containerB.queue.findById(claimedB!.id)?.status).toBe('running');

        containerB.queue.markSucceeded(claimedB!.id, new Date());
        containerB.leases.release({
          repoId: containerB.repo.id,
          workerId: workerIdB,
          runId: runIdB,
          leaseToken: leaseB.leaseToken,
        });

        expect(containerB.queue.findById(claimedB!.id)?.status).toBe('succeeded');
        expect(containerB.leases.current(containerB.repo.id)).toBeUndefined();
      });

      it('repo B artifacts and events remain unchanged during repo A recovery', () => {
        const runIdA = RunId('run-a-42');
        const runIdB = RunId('run-b-42');
        const now = new Date();

        containerA.eventBus.publish(runIdA, {
          runId: 'run-a-42',
          level: 'info',
          type: 'run.started',
          message: 'started A',
          timestamp: now.toISOString(),
          metadata: { repoId: containerA.repo.id },
        });

        containerB.eventBus.publish(runIdB, {
          runId: 'run-b-42',
          level: 'info',
          type: 'run.started',
          message: 'started B',
          timestamp: now.toISOString(),
          metadata: { repoId: containerB.repo.id },
        });

        containerB.eventBus.publish(runIdB, {
          runId: 'run-b-42',
          level: 'info',
          type: 'phase.started',
          message: 'planning B',
          timestamp: now.toISOString(),
          metadata: { repoId: containerB.repo.id },
        });

        const eventsBeforeA = (containerA.eventBus as FakeEventBus).published.length;
        const eventsBeforeB = (containerB.eventBus as FakeEventBus).published.length;

        const expiredTime = new Date(now.getTime() + 120_000);

        containerA.leases.reclaimExpired({
          now: expiredTime,
          recoverableRunIds: new Set([runIdA]),
          isWorkerAlive: () => false,
          resetWorktree: (_repoId) => {},
          onReclaimed: (_info) => {},
          reclaimedByWorkerId: WorkerId('reclaimer'),
        });

        containerA.eventBus.publish(runIdA, {
          runId: 'run-a-42',
          level: 'info',
          type: 'run.reclaimed',
          message: 'reclaimed A',
          timestamp: new Date(expiredTime.getTime() + 1000).toISOString(),
          metadata: { repoId: containerA.repo.id },
        });

        const eventsAfterA = (containerA.eventBus as FakeEventBus).published.length;
        const eventsAfterB = (containerB.eventBus as FakeEventBus).published.length;

        expect(eventsAfterA).toBeGreaterThan(eventsBeforeA);
        expect(eventsAfterB).toBe(eventsBeforeB);

        const allEventsB = (containerB.eventBus as FakeEventBus).published;
        expect(
          allEventsB.filter((e) => e.event.metadata?.repoId === containerB.repo.id),
        ).toHaveLength(eventsBeforeB);
        expect(allEventsB.every((e) => e.event.metadata?.repoId === containerB.repo.id)).toBe(true);
      });
    });
  });
});
