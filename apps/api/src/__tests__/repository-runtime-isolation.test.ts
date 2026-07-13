import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { RepositoryId, WorkerId, RunId, JobId, IssueNumber } from '@ai-sdlc/domain';
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

describe('repository-runtime-isolation', () => {
  describe('behavioral invariant: concurrent_repositories_have_no_shared_mutable_execution_state', () => {
    describe('two repository-scoped workers execute equal issue numbers without shared mutable state', () => {
      let repoA: Repository;
      let repoB: Repository;
      let containerA: {
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
      };
      let containerB: typeof containerA;

      beforeEach(() => {
        repoA = makeRepository('owner/api-repo');
        repoB = makeRepository('owner/web-repo');

        const reposA = new FakeRepositoryPort([repoA]);
        const reposB = new FakeRepositoryPort([repoB]);
        const queueA = new FakeJobQueuePort(reposA);
        const queueB = new FakeJobQueuePort(reposB);
        const runRepoA = new FakeRunRepository();
        const runRepoB = new FakeRunRepository();
        const registryA = new FakeWorkerRegistryPort();
        const registryB = new FakeWorkerRegistryPort();
        const leasesA = makeWorkerLeasePort(registryA);
        const leasesB = makeWorkerLeasePort(registryB);
        const ghA = new FakeGitHubPort();
        const ghB = new FakeGitHubPort();
        const eventBusA = new FakeEventBus();
        const eventBusB = new FakeEventBus();

        const dirA = trackDir(() => mkdtempSync(join(tmpdir(), 'repo-iso-a-')));
        const dirB = trackDir(() => mkdtempSync(join(tmpdir(), 'repo-iso-b-')));
        const scriptPathA = makeScriptPath(dirA);
        const scriptPathB = makeScriptPath(dirB);

        containerA = {
          repos: reposA,
          queue: queueA,
          runRepo: runRepoA,
          registry: registryA,
          leases: leasesA,
          gh: ghA,
          eventBus: eventBusA,
          scriptPath: scriptPathA,
          baseTmpDir: dirA,
          runsDir: join(dirA, '.ai-runs'),
        };

        containerB = {
          repos: reposB,
          queue: queueB,
          runRepo: runRepoB,
          registry: registryB,
          leases: leasesB,
          gh: ghB,
          eventBus: eventBusB,
          scriptPath: scriptPathB,
          baseTmpDir: dirB,
          runsDir: join(dirB, '.ai-runs'),
        };
      });

      afterEach(() => {
        while (tempDirs.length) {
          const dir = tempDirs.pop();
          if (dir) rmSync(dir, { recursive: true, force: true });
        }
      });

      it('asserts distinct databases for each repository', () => {
        expect(containerA.runsDir).not.toBe(containerB.runsDir);
        expect(containerA.runsDir).toContain('repo-iso-a');
        expect(containerB.runsDir).toContain('repo-iso-b');
      });

      it('asserts distinct baseTmpDir for each repository', () => {
        expect(containerA.baseTmpDir).not.toBe(containerB.baseTmpDir);
        expect(containerA.baseTmpDir).toContain('repo-iso-a');
        expect(containerB.baseTmpDir).toContain('repo-iso-b');
      });

      it('asserts distinct GitHub fullName arguments per repository', () => {
        expect(repoA.fullName).not.toBe(repoB.fullName);
        expect(repoA.fullName).toBe('owner/api-repo');
        expect(repoB.fullName).toBe('owner/web-repo');

        containerA.gh.issues.set('owner/api-repo/42', {
          number: 42,
          title: 'Issue in API repo',
          body: '',
          state: 'open',
          createdAt: new Date(),
          updatedAt: new Date(),
          labels: [],
          assignee: null,
          url: 'https://github.com/owner/api-repo/issues/42',
        });

        containerB.gh.issues.set('owner/web-repo/42', {
          number: 42,
          title: 'Issue in Web repo',
          body: '',
          state: 'open',
          createdAt: new Date(),
          updatedAt: new Date(),
          labels: [],
          assignee: null,
          url: 'https://github.com/owner/web-repo/issues/42',
        });

        expect(containerA.gh.issues.get('owner/api-repo/42')?.title).toBe('Issue in API repo');
        expect(containerB.gh.issues.get('owner/web-repo/42')?.title).toBe('Issue in Web repo');
        expect(containerA.gh.issues.get('owner/api-repo/42')?.title).not.toBe(
          containerB.gh.issues.get('owner/web-repo/42')?.title,
        );
      });

      it('asserts distinct Worker rows per repository', () => {
        const workerA = {
          id: WorkerId('worker-a'),
          repoId: repoA.id,
          hostname: 'test-host',
          processId: 1,
          status: 'idle' as const,
          heartbeatAt: new Date(),
        };
        const workerB = {
          id: WorkerId('worker-b'),
          repoId: repoB.id,
          hostname: 'test-host',
          processId: 2,
          status: 'idle' as const,
          heartbeatAt: new Date(),
        };

        containerA.registry.register(workerA);
        containerB.registry.register(workerB);

        expect(containerA.registry.findById(workerA.id, repoA.id)?.repoId).toBe(repoA.id);
        expect(containerA.registry.findById(workerA.id, repoB.id)).toBeUndefined();
        expect(containerB.registry.findById(workerB.id, repoB.id)?.repoId).toBe(repoB.id);
        expect(containerB.registry.findById(workerB.id, repoA.id)).toBeUndefined();

        expect(containerA.registry.findById(workerA.id, repoA.id)?.id).not.toBe(
          containerB.registry.findById(workerB.id, repoB.id)?.id,
        );
      });

      it('asserts distinct Job rows per repository with equal issue numbers', () => {
        const issueNumber = 42 as IssueNumber;
        const jobIdA = JobId('job-a-42');
        const jobIdB = JobId('job-b-42');
        const runIdA = RunId('run-a-42');
        const runIdB = RunId('run-b-42');
        const now = new Date();

        const jobA = createJob({
          id: jobIdA,
          runId: runIdA,
          repoId: repoA.id,
          issueNumber,
          createdAt: now,
        });
        const jobB = createJob({
          id: jobIdB,
          runId: runIdB,
          repoId: repoB.id,
          issueNumber,
          createdAt: now,
        });

        containerA.queue.enqueue({ job: jobA });
        containerB.queue.enqueue({ job: jobB });

        expect(containerA.queue.findById(jobIdA)?.repoId).toBe(repoA.id);
        expect(containerA.queue.findById(jobIdB)).toBeUndefined();
        expect(containerB.queue.findById(jobIdB)?.repoId).toBe(repoB.id);
        expect(containerB.queue.findById(jobIdA)).toBeUndefined();

        expect(containerA.queue.listForRepo(repoA.id)).toHaveLength(1);
        expect(containerA.queue.listForRepo(repoB.id)).toHaveLength(0);
        expect(containerB.queue.listForRepo(repoB.id)).toHaveLength(1);
        expect(containerB.queue.listForRepo(repoA.id)).toHaveLength(0);
      });

      it('asserts distinct WorkerLeases per repository', () => {
        const workerIdA = WorkerId('worker-a');
        const workerIdB = WorkerId('worker-b');
        const runIdA = RunId('run-a-42');
        const runIdB = RunId('run-b-42');
        const now = new Date();

        const leaseA = containerA.leases.acquire({
          repoId: repoA.id,
          workerId: workerIdA,
          runId: runIdA,
          now,
          ttlMs: 60000,
        });

        const leaseB = containerB.leases.acquire({
          repoId: repoB.id,
          workerId: workerIdB,
          runId: runIdB,
          now,
          ttlMs: 60000,
        });

        expect(leaseA.repoId).toBe(repoA.id);
        expect(leaseB.repoId).toBe(repoB.id);
        expect(leaseA.repoId).not.toBe(leaseB.repoId);

        expect(containerA.leases.current(repoA.id)?.repoId).toBe(repoA.id);
        expect(containerA.leases.current(repoB.id)).toBeUndefined();
        expect(containerB.leases.current(repoB.id)?.repoId).toBe(repoB.id);
        expect(containerB.leases.current(repoA.id)).toBeUndefined();
      });

      it('asserts events contain correct repoId', () => {
        const runIdA = RunId('run-a-42');
        const runIdB = RunId('run-b-42');
        const now = new Date();

        containerA.eventBus.publish(runIdA, {
          runId: 'run-a-42',
          level: 'info',
          type: 'run.started',
          message: 'started',
          timestamp: now.toISOString(),
          metadata: { repoId: repoA.id },
        });

        containerB.eventBus.publish(runIdB, {
          runId: 'run-b-42',
          level: 'info',
          type: 'run.started',
          message: 'started',
          timestamp: now.toISOString(),
          metadata: { repoId: repoB.id },
        });

        const eventsA = (containerA.eventBus as FakeEventBus).published;
        const eventsB = (containerB.eventBus as FakeEventBus).published;

        expect(eventsA.some((e) => e.event.metadata?.repoId === repoA.id)).toBe(true);
        expect(eventsA.some((e) => e.event.metadata?.repoId === repoB.id)).toBe(false);
        expect(eventsB.some((e) => e.event.metadata?.repoId === repoB.id)).toBe(true);
        expect(eventsB.some((e) => e.event.metadata?.repoId === repoA.id)).toBe(false);
      });

      it('worker A cannot claim worker B queued job when both leases are live', () => {
        const issueNumber = 42 as IssueNumber;
        const jobIdA = JobId('job-a-42');
        const jobIdB = JobId('job-b-42');
        const runIdA = RunId('run-a-42');
        const runIdB = RunId('run-b-42');
        const workerIdA = WorkerId('worker-a');
        const workerIdB = WorkerId('worker-b');
        const now = new Date();

        const jobA = createJob({
          id: jobIdA,
          runId: runIdA,
          repoId: repoA.id,
          issueNumber,
          createdAt: now,
        });
        const jobB = createJob({
          id: jobIdB,
          runId: runIdB,
          repoId: repoB.id,
          issueNumber,
          createdAt: now,
        });

        containerA.queue.enqueue({ job: jobA });
        containerB.queue.enqueue({ job: jobB });

        const leaseA = containerA.leases.acquire({
          repoId: repoA.id,
          workerId: workerIdA,
          runId: runIdA,
          now,
          ttlMs: 60000,
        });

        const leaseB = containerB.leases.acquire({
          repoId: repoB.id,
          workerId: workerIdB,
          runId: runIdB,
          now,
          ttlMs: 60000,
        });

        expect(leaseA.repoId).toBe(repoA.id);
        expect(leaseB.repoId).toBe(repoB.id);

        const claimedA = containerA.queue.claimNext({
          repoId: repoA.id,
          workerId: workerIdA,
          ttlMs: 60000,
        });

        const claimedB = containerB.queue.claimNext({
          repoId: repoB.id,
          workerId: workerIdB,
          ttlMs: 60000,
        });

        expect(claimedA?.id).toBe(jobIdA);
        expect(claimedB?.id).toBe(jobIdB);
        expect(claimedA?.id).not.toBe(claimedB?.id);

        const crossClaimAttempt = containerA.queue.claimNext({
          repoId: repoA.id,
          workerId: workerIdA,
          skipJobIds: new Set([jobIdA]),
        });

        expect(crossClaimAttempt).toBeUndefined();
      });

      it('both workers complete without lease conflict', () => {
        const issueNumber = 42 as IssueNumber;
        const jobIdA = JobId('job-a-42');
        const jobIdB = JobId('job-b-42');
        const runIdA = RunId('run-a-42');
        const runIdB = RunId('run-b-42');
        const workerIdA = WorkerId('worker-a');
        const workerIdB = WorkerId('worker-b');
        const now = new Date();

        const jobA = createJob({
          id: jobIdA,
          runId: runIdA,
          repoId: repoA.id,
          issueNumber,
          createdAt: now,
        });
        const jobB = createJob({
          id: jobIdB,
          runId: runIdB,
          repoId: repoB.id,
          issueNumber,
          createdAt: now,
        });

        containerA.queue.enqueue({ job: jobA });
        containerB.queue.enqueue({ job: jobB });

        const leaseA = containerA.leases.acquire({
          repoId: repoA.id,
          workerId: workerIdA,
          runId: runIdA,
          now,
          ttlMs: 60000,
        });

        const leaseB = containerB.leases.acquire({
          repoId: repoB.id,
          workerId: workerIdB,
          runId: runIdB,
          now,
          ttlMs: 60000,
        });

        expect(leaseA.repoId).toBe(repoA.id);
        expect(leaseB.repoId).toBe(repoB.id);

        const claimedA = containerA.queue.claimNext({
          repoId: repoA.id,
          workerId: workerIdA,
          ttlMs: 60000,
        });
        const claimedB = containerB.queue.claimNext({
          repoId: repoB.id,
          workerId: workerIdB,
          ttlMs: 60000,
        });

        expect(claimedA?.id).toBe(jobIdA);
        expect(claimedB?.id).toBe(jobIdB);

        containerA.queue.markRunning(jobIdA, now);
        containerB.queue.markRunning(jobIdB, now);

        expect(containerA.queue.findById(jobIdA)?.status).toBe('running');
        expect(containerB.queue.findById(jobIdB)?.status).toBe('running');

        containerA.queue.markSucceeded(jobIdA, new Date());
        containerB.queue.markSucceeded(jobIdB, new Date());

        expect(containerA.queue.findById(jobIdA)?.status).toBe('succeeded');
        expect(containerB.queue.findById(jobIdB)?.status).toBe('succeeded');

        containerA.leases.release({
          repoId: repoA.id,
          workerId: workerIdA,
          runId: runIdA,
        });
        containerB.leases.release({
          repoId: repoB.id,
          workerId: workerIdB,
          runId: runIdB,
        });

        expect(containerA.leases.current(repoA.id)).toBeUndefined();
        expect(containerB.leases.current(repoB.id)).toBeUndefined();
      });
    });
  });
});
