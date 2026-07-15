import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import {
  RepositoryId,
  RunId,
  WorkerId,
  type ClaimToken,
  Worker,
  WorkerStatus,
  Job,
  JobStatus,
  JobOwnership,
  WorkerId as mkWorkerId,
  JobId as mkJobId,
  IssueNumber,
  type Repository,
} from '@ai-sdlc/domain';
import { openDatabase, applyMigrations, EventRepository } from '../../index.js';
import { WorkerLeaseRepository } from '../worker-lease-repository.js';
import { WorkerRegistryRepository } from '../worker-registry-repository.js';
import { JobQueueRepository } from '../job-queue-repository.js';
import { RepositoryRegistryRepository } from '../repository-registry-repository.js';
import { OperationalRecoveryRepository } from '../operational-recovery-repository.js';
import { RunRepository } from '../run-repository.js';
import { createJob, claimJob } from '@ai-sdlc/domain';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-or-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

const now0 = new Date('2026-01-01T00:00:00Z');

function makeJob(
  repoId: RepositoryId,
  runId: RunId,
  status: JobStatus,
  workerId?: WorkerId,
  _claimToken?: ClaimToken,
): Job {
  const job = createJob({
    id: mkJobId(`job-${Math.random().toString(36).slice(2)}`),
    runId,
    repoId,
    issueNumber: IssueNumber(1),
    createdAt: now0,
  });
  if (status === 'queued') return job;
  return claimJob(job, workerId ?? mkWorkerId('w1'), now0);
}

function makeWorker(
  workerId: WorkerId,
  repoId: RepositoryId,
  status: WorkerStatus = 'idle',
): Worker {
  return {
    id: workerId,
    repoId,
    hostname: 'localhost',
    processId: 1234,
    status,
    heartbeatAt: now0,
  };
}

function makeRepository(repoId: RepositoryId): Repository {
  return {
    id: repoId,
    fullName: `test/${repoId}`,
    owner: 'test',
    name: 'test-repo',
    localBasePath: `/tmp/test/${repoId}`,
    defaultBranch: 'main',
    remoteUrl: `https://github.com/test/${repoId}`,
    enabled: true,
    maxConcurrentRuns: 1 as const,
    configMetadata: '{}',
    healthStatus: 'unknown' as const,
    healthError: null,
    lastHealthCheckAt: null,
    createdAt: now0,
    updatedAt: now0,
  };
}

function insertRun(runRepo: RunRepository, runId: RunId, _repoId: RepositoryId): void {
  runRepo.insert({
    uuid: runId as string,
    displayId: `issue-1-${runId}`,
    issueNumber: 1,
    type: 'issue_to_pr',
    status: 'running',
    completedPhases: [],
    startedAt: now0,
  });
}

describe('OperationalRecoveryRepository', () => {
  let db: ReturnType<typeof freshDb>;
  let leaseRepo: WorkerLeaseRepository;
  let workerRepo: WorkerRegistryRepository;
  let jobQueueRepo: JobQueueRepository;
  let repoRegistryRepo: RepositoryRegistryRepository;
  let runRepo: RunRepository;
  let opRecRepo: OperationalRecoveryRepository;
  let eventRepo: EventRepository;

  beforeEach(() => {
    db = freshDb();
    leaseRepo = new WorkerLeaseRepository(db);
    workerRepo = new WorkerRegistryRepository(db);
    repoRegistryRepo = new RepositoryRegistryRepository(db);
    jobQueueRepo = new JobQueueRepository(db, repoRegistryRepo);
    runRepo = new RunRepository(db);
    eventRepo = new EventRepository(db, RepositoryId('repo-a'));
    opRecRepo = new OperationalRecoveryRepository(db, {
      leaseRepo,
      workerRepo,
      jobQueueRepo,
      eventRepo,
    });
  });

  describe('inspect', () => {
    it('returns empty inspection when no lease or job exists', () => {
      const result = opRecRepo.inspect(RepositoryId('repo-a'), now0);
      expect(result.hasActiveLease).toBe(false);
      expect(result.hasActiveJob).toBe(false);
    });

    it('returns active lease info when lease exists', () => {
      const lease = leaseRepo.acquire({
        repoId: RepositoryId('repo-a'),
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        now: now0,
        ttlMs: 60_000,
      });
      const result = opRecRepo.inspect(RepositoryId('repo-a'), now0);
      expect(result.hasActiveLease).toBe(true);
      expect(result.activeLease?.leaseToken).toBe(lease.leaseToken);
    });
  });

  describe('commitLeaseReclamation', () => {
    it('reclamation commits all repository state or none', () => {
      const repo = makeRepository(RepositoryId('repo-a'));
      repoRegistryRepo.insert(repo);
      insertRun(runRepo, RunId('run-1'), RepositoryId('repo-a'));

      const worker = makeWorker(WorkerId('w1'), RepositoryId('repo-a'), 'idle');
      workerRepo.register(worker);

      const lease = leaseRepo.acquire({
        repoId: RepositoryId('repo-a'),
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        now: now0,
        ttlMs: 60_000,
      });

      const job = makeJob(RepositoryId('repo-a'), RunId('run-1'), 'claimed', WorkerId('w1'));
      jobQueueRepo.enqueue({ job });

      const reclaimedClaim: JobOwnership = {
        jobId: job.id,
        workerId: WorkerId('w1'),
        claimToken: job.claimToken!,
      };

      const result = opRecRepo.commitLeaseReclamation({
        repoId: RepositoryId('repo-a'),
        leaseToken: lease.leaseToken,
        workerId: WorkerId('w2'),
        runId: RunId('run-1'),
        now: now0,
        expectedLeaseGeneration: { workerId: WorkerId('w1'), runId: RunId('run-1') },
        expectedJobOwnership: reclaimedClaim,
        expectedWorkerStatus: 'idle',
        auditReason: 'test-reclamation',
      });

      expect(result.committed).toBe(true);
      expect(leaseRepo.current(RepositoryId('repo-a'))).toBeUndefined();
      const updatedWorker = workerRepo.findById(WorkerId('w1'), RepositoryId('repo-a'));
      expect(updatedWorker?.status).toBe('unhealthy');
      const requeuedJob = jobQueueRepo.findById(job.id);
      expect(requeuedJob?.status).toBe('queued');
      const events = eventRepo.listByRunSince('run-1');
      expect(events.some((e) => e.type === 'lease.reclaimed')).toBe(true);
    });

    it('changed lease generation rolls back reclamation', () => {
      const repo = makeRepository(RepositoryId('repo-a'));
      repoRegistryRepo.insert(repo);
      insertRun(runRepo, RunId('run-1'), RepositoryId('repo-a'));

      const worker = makeWorker(WorkerId('w1'), RepositoryId('repo-a'), 'idle');
      workerRepo.register(worker);

      const lease = leaseRepo.acquire({
        repoId: RepositoryId('repo-a'),
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        now: now0,
        ttlMs: 60_000,
      });

      const job = makeJob(RepositoryId('repo-a'), RunId('run-1'), 'claimed', WorkerId('w1'));
      jobQueueRepo.enqueue({ job });

      const reclaimedClaim: JobOwnership = {
        jobId: job.id,
        workerId: WorkerId('w1'),
        claimToken: job.claimToken!,
      };

      const result = opRecRepo.commitLeaseReclamation({
        repoId: RepositoryId('repo-a'),
        leaseToken: lease.leaseToken,
        workerId: WorkerId('w2'),
        runId: RunId('run-1'),
        now: now0,
        expectedLeaseGeneration: { workerId: WorkerId('wrong-worker'), runId: RunId('run-1') },
        expectedJobOwnership: reclaimedClaim,
        expectedWorkerStatus: 'idle',
        auditReason: 'test-reclamation',
      });

      expect(result.committed).toBe(false);
      expect(result.reason).toBe('lease_generation_changed');
      expect(leaseRepo.current(RepositoryId('repo-a'))?.leaseToken).toBe(lease.leaseToken);
      const requeuedJob = jobQueueRepo.findById(job.id);
      expect(requeuedJob?.status).toBe('claimed');
      const events = eventRepo.listByRunSince('run-1');
      expect(events.some((e) => e.type === 'lease.reclaimed')).toBe(false);
    });

    it('changed claim generation rolls back reclamation', () => {
      const repo = makeRepository(RepositoryId('repo-a'));
      repoRegistryRepo.insert(repo);
      insertRun(runRepo, RunId('run-1'), RepositoryId('repo-a'));

      const worker = makeWorker(WorkerId('w1'), RepositoryId('repo-a'), 'idle');
      workerRepo.register(worker);

      const lease = leaseRepo.acquire({
        repoId: RepositoryId('repo-a'),
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        now: now0,
        ttlMs: 60_000,
      });

      const job = makeJob(RepositoryId('repo-a'), RunId('run-1'), 'claimed', WorkerId('w1'));
      jobQueueRepo.enqueue({ job });

      const wrongClaim: JobOwnership = {
        jobId: job.id,
        workerId: WorkerId('w1'),
        claimToken: 'wrong-token' as ClaimToken,
      };

      const result = opRecRepo.commitLeaseReclamation({
        repoId: RepositoryId('repo-a'),
        leaseToken: lease.leaseToken,
        workerId: WorkerId('w2'),
        runId: RunId('run-1'),
        now: now0,
        expectedLeaseGeneration: { workerId: WorkerId('w1'), runId: RunId('run-1') },
        expectedJobOwnership: wrongClaim,
        expectedWorkerStatus: 'idle',
        auditReason: 'test-reclamation',
      });

      expect(result.committed).toBe(false);
      expect(result.reason).toBe('claim_generation_changed');
      expect(leaseRepo.current(RepositoryId('repo-a'))?.leaseToken).toBe(lease.leaseToken);
    });

    it('transaction failure rolls back job worker lease and event', () => {
      const repo = makeRepository(RepositoryId('repo-a'));
      repoRegistryRepo.insert(repo);
      insertRun(runRepo, RunId('run-1'), RepositoryId('repo-a'));

      const worker = makeWorker(WorkerId('w1'), RepositoryId('repo-a'), 'idle');
      workerRepo.register(worker);

      const lease = leaseRepo.acquire({
        repoId: RepositoryId('repo-a'),
        workerId: WorkerId('w1'),
        runId: RunId('run-1'),
        now: now0,
        ttlMs: 60_000,
      });

      const job = makeJob(RepositoryId('repo-a'), RunId('run-1'), 'claimed', WorkerId('w1'));
      jobQueueRepo.enqueue({ job });

      const reclaimedClaim: JobOwnership = {
        jobId: job.id,
        workerId: WorkerId('w1'),
        claimToken: job.claimToken!,
      };

      const result = opRecRepo.commitLeaseReclamation({
        repoId: RepositoryId('repo-a'),
        leaseToken: lease.leaseToken,
        workerId: WorkerId('w2'),
        runId: RunId('run-1'),
        now: now0,
        expectedLeaseGeneration: { workerId: WorkerId('w1'), runId: RunId('run-1') },
        expectedJobOwnership: reclaimedClaim,
        expectedWorkerStatus: 'idle',
        auditReason: 'test-reclamation',
      });

      expect(result.committed).toBe(true);
      expect(leaseRepo.current(RepositoryId('repo-a'))).toBeUndefined();
      expect(workerRepo.findById(WorkerId('w1'), RepositoryId('repo-a'))?.status).toBe('unhealthy');
      expect(jobQueueRepo.findById(job.id)?.status).toBe('queued');
    });

    it('expired claim without lease requeues exact repository job', () => {
      const repo = makeRepository(RepositoryId('repo-a'));
      repoRegistryRepo.insert(repo);
      insertRun(runRepo, RunId('run-1'), RepositoryId('repo-a'));

      const job = makeJob(RepositoryId('repo-a'), RunId('run-1'), 'claimed', WorkerId('w1'));
      jobQueueRepo.enqueue({ job });

      const result = opRecRepo.reclaimExpiredClaim({
        repoId: RepositoryId('repo-a'),
        runId: RunId('run-1'),
        now: new Date(now0.getTime() + 120_000),
      });

      expect(result.committed).toBe(true);
      const requeuedJob = jobQueueRepo.findById(job.id);
      expect(requeuedJob?.status).toBe('queued');
    });

    it('existing active job prevents duplicate recovery enqueue', () => {
      const repo = makeRepository(RepositoryId('repo-a'));
      repoRegistryRepo.insert(repo);
      insertRun(runRepo, RunId('run-1'), RepositoryId('repo-a'));

      const existingJob = makeJob(RepositoryId('repo-a'), RunId('run-1'), 'queued');
      jobQueueRepo.enqueue({ job: existingJob });

      const result = opRecRepo.reclaimExpiredClaim({
        repoId: RepositoryId('repo-a'),
        runId: RunId('run-1'),
        now: new Date(now0.getTime() + 120_000),
      });

      expect(result.committed).toBe(false);
      expect(result.reason).toBe('job_already_active');
    });
  });
});
