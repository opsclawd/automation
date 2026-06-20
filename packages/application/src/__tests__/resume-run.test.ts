import { describe, expect, it } from 'vitest';
import type { RunId, WorkerId, RepositoryId } from '@ai-sdlc/domain';
import { ResumeRun } from '../resume-run.js';
import { FakeRepositoryPort } from '../test-doubles/fake-repository-port.js';
import { FakeWorkerLeasePort } from '../test-doubles/fake-worker-lease-port.js';
import { FakeJobQueuePort } from '../test-doubles/fake-job-queue-port.js';
import { FakeStepRepository } from '../test-doubles/fake-step-repository.js';
import { FakePhaseRepository } from '../test-doubles/fake-phase-repository.js';
import { FakeWorkerRegistryPort } from '../test-doubles/fake-worker-registry-port.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';
import type { RunRecord } from '../ports.js';

const wid = (s: string) => s as WorkerId;
const rid = (s: string) => s as RunId;
const repoid = (s: string) => s as RepositoryId;

const fakeNow = new Date('2026-06-01T00:00:00Z');
const fixedNow = () => fakeNow;

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    uuid: 'run-1',
    displayId: 'issue-1-20260601-000000',
    issueNumber: 1,
    type: 'issue_to_pr',
    status: 'failed',
    completedPhases: [],
    skippedPhases: [],
    startedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

const seededRepo = {
  id: repoid('run-1'),
  owner: 'o',
  name: 'n',
  fullName: 'o/n',
  defaultBranch: 'main',
  localBasePath: '/tmp',
  enabled: true,
  maxConcurrentRuns: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('ResumeRun', () => {
  it('resumes a failed run', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeRun({ completedPhases: ['phase-1'], skippedPhases: ['phase-2'] }));
    const registry = new FakeWorkerRegistryPort();
    registry.register({ workerId: wid('w-1'), status: 'healthy' });
    const leases = new FakeWorkerLeasePort(registry);
    const repos = new FakeRepositoryPort([seededRepo]);
    const queue = new FakeJobQueuePort(repos);
    const stepRepo = new FakeStepRepository();
    const phaseRepo = new FakePhaseRepository();
    const usecase = new ResumeRun({
      runRepository: runRepo,
      repos,
      leases,
      queue,
      stepRepo,
      phaseRepo,
      findRepoId: (r) => repoid(r),
      now: fixedNow,
    });
    await usecase.execute({ runId: rid('run-1'), workerId: wid('w-1') });
    expect(runRepo.updates).toHaveLength(1);
    expect(runRepo.updates[0]!.patch.status).toBe('running');
    expect(runRepo.updates[0]!.patch.completedPhases).toEqual([]);
    expect(runRepo.updates[0]!.patch.skippedPhases).toEqual([]);
  });

  it('throws when run is not found', async () => {
    const runRepo = new FakeRunRepository();
    const registry = new FakeWorkerRegistryPort();
    registry.register({ workerId: wid('w-1'), status: 'healthy' });
    const usecase = new ResumeRun({
      runRepository: runRepo,
      repos: new FakeRepositoryPort([seededRepo]),
      leases: new FakeWorkerLeasePort(registry),
      queue: new FakeJobQueuePort(new FakeRepositoryPort([seededRepo])),
      stepRepo: new FakeStepRepository(),
      phaseRepo: new FakePhaseRepository(),
      findRepoId: (r) => repoid(r),
      now: fixedNow,
    });
    await expect(
      usecase.execute({ runId: rid('nonexistent'), workerId: wid('w-1') }),
    ).rejects.toThrow(/no run found/i);
  });

  it('throws when run is not failed', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeRun({ status: 'running' }));
    const registry = new FakeWorkerRegistryPort();
    registry.register({ workerId: wid('w-1'), status: 'healthy' });
    const usecase = new ResumeRun({
      runRepository: runRepo,
      repos: new FakeRepositoryPort([seededRepo]),
      leases: new FakeWorkerLeasePort(registry),
      queue: new FakeJobQueuePort(new FakeRepositoryPort([seededRepo])),
      stepRepo: new FakeStepRepository(),
      phaseRepo: new FakePhaseRepository(),
      findRepoId: (r) => repoid(r),
      now: fixedNow,
    });
    await expect(usecase.execute({ runId: rid('run-1'), workerId: wid('w-1') })).rejects.toThrow(
      /cannot resume/i,
    );
  });

  it('throws when run is passed', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeRun({ status: 'passed' }));
    const registry = new FakeWorkerRegistryPort();
    registry.register({ workerId: wid('w-1'), status: 'healthy' });
    const usecase = new ResumeRun({
      runRepository: runRepo,
      repos: new FakeRepositoryPort([seededRepo]),
      leases: new FakeWorkerLeasePort(registry),
      queue: new FakeJobQueuePort(new FakeRepositoryPort([seededRepo])),
      stepRepo: new FakeStepRepository(),
      phaseRepo: new FakePhaseRepository(),
      findRepoId: (r) => repoid(r),
      now: fixedNow,
    });
    await expect(usecase.execute({ runId: rid('run-1'), workerId: wid('w-1') })).rejects.toThrow(
      /cannot resume/i,
    );
  });

  it('acquires a lease on resume', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeRun());
    const registry = new FakeWorkerRegistryPort();
    registry.register({ workerId: wid('w-1'), status: 'healthy' });
    const leases = new FakeWorkerLeasePort(registry);
    const repos = new FakeRepositoryPort([seededRepo]);
    const usecase = new ResumeRun({
      runRepository: runRepo,
      repos,
      leases,
      queue: new FakeJobQueuePort(repos),
      stepRepo: new FakeStepRepository(),
      phaseRepo: new FakePhaseRepository(),
      findRepoId: (r) => repoid(r),
      now: fixedNow,
    });
    await usecase.execute({ runId: rid('run-1'), workerId: wid('w-1') });
    const lease = leases.current(repoid('run-1'));
    expect(lease).toBeDefined();
    expect(lease!.workerId).toBe('w-1');
  });

  it('enqueues a job on resume', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeRun());
    const registry = new FakeWorkerRegistryPort();
    registry.register({ workerId: wid('w-1'), status: 'healthy' });
    const repos = new FakeRepositoryPort([seededRepo]);
    const queue = new FakeJobQueuePort(repos);
    const usecase = new ResumeRun({
      runRepository: runRepo,
      repos,
      leases: new FakeWorkerLeasePort(registry),
      queue,
      stepRepo: new FakeStepRepository(),
      phaseRepo: new FakePhaseRepository(),
      findRepoId: (r) => repoid(r),
      now: fixedNow,
    });
    await usecase.execute({ runId: rid('run-1'), workerId: wid('w-1') });
    const jobs = queue.listForRun(rid('run-1'));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('queued');
  });

  it('throws when repo is disabled', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeRun());
    const registry = new FakeWorkerRegistryPort();
    registry.register({ workerId: wid('w-1'), status: 'healthy' });
    const repos = new FakeRepositoryPort([{ ...seededRepo, enabled: false }]);
    const usecase = new ResumeRun({
      runRepository: runRepo,
      repos,
      leases: new FakeWorkerLeasePort(registry),
      queue: new FakeJobQueuePort(repos),
      stepRepo: new FakeStepRepository(),
      phaseRepo: new FakePhaseRepository(),
      findRepoId: (r) => repoid(r),
      now: fixedNow,
    });
    await expect(usecase.execute({ runId: rid('run-1'), workerId: wid('w-1') })).rejects.toThrow(
      /disabled/i,
    );
  });

  it('with fromPhase resets steps and sets currentPhase', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeRun());
    const registry = new FakeWorkerRegistryPort();
    registry.register({ workerId: wid('w-1'), status: 'healthy' });
    const repos = new FakeRepositoryPort([seededRepo]);
    const stepRepo = new FakeStepRepository();
    stepRepo.upsert({
      id: 's1',
      runId: 'run-1',
      phaseId: 'test-phase',
      index: 0,
      title: 'Step 1',
      status: 'failed',
      startedAt: new Date(),
      completedAt: new Date(),
    });
    const usecase = new ResumeRun({
      runRepository: runRepo,
      repos,
      leases: new FakeWorkerLeasePort(registry),
      queue: new FakeJobQueuePort(repos),
      stepRepo,
      phaseRepo: new FakePhaseRepository(),
      findRepoId: (r) => repoid(r),
      now: fixedNow,
    });
    await usecase.execute({ runId: rid('run-1'), workerId: wid('w-1'), fromPhase: 'test-phase' });
    const steps = stepRepo.listForRun(rid('run-1'));
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe('pending');
    expect(steps[0]!.startedAt).toBeUndefined();
    expect(steps[0]!.completedAt).toBeUndefined();
    expect(runRepo.updates[0]!.patch.currentPhase).toBe('test-phase');
  });
});
