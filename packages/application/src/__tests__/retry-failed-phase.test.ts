import { describe, expect, it } from 'vitest';
import type { RunId, WorkerId } from '@ai-sdlc/domain';
import { RetryFailedPhase } from '../retry-failed-phase.js';
import type { RunRecord, RunRepositoryPort } from '../ports.js';
import { FakeResumeRun } from '../test-doubles/fake-resume-run.js';
import { FakePhaseRepository } from '../test-doubles/fake-phase-repository.js';

const wid = (s: string) => s as WorkerId;
const rid = (s: string) => s as RunId;

class FakeRunRepoForRetry implements RunRepositoryPort {
  private runs = new Map<string, RunRecord>();
  findByUuid(uuid: string) {
    return this.runs.get(uuid);
  }
  add(run: RunRecord) {
    this.runs.set(run.uuid, run);
  }
  insertIfNoActive() {}
  update() {}
  findByIssueNumber() {
    return undefined;
  }
  findActiveRuns() {
    return [];
  }
  updateStatusByIssueNumber() {
    return false;
  }
  updateStatusByUuid() {
    return false;
  }
}

function makeFailedRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    uuid: 'run-rp-1',
    displayId: 'issue-1-20260601-000000',
    issueNumber: 1,
    type: 'issue_to_pr',
    status: 'failed',
    currentPhase: 'implement',
    completedPhases: ['read_issue', 'plan'],
    skippedPhases: [],
    startedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

describe('RetryFailedPhase', () => {
  it('delegates to resumeRun with fromPhase = run.currentPhase and attempt count', async () => {
    const runRepo = new FakeRunRepoForRetry();
    runRepo.add(makeFailedRun());
    const resumeRun = new FakeResumeRun();
    const phaseRepo = new FakePhaseRepository();
    const usecase = new RetryFailedPhase({ runRepository: runRepo, phaseRepo, resumeRun });
    await usecase.execute({ runId: rid('run-rp-1'), workerId: wid('w-1') });
    expect(resumeRun.calls).toHaveLength(1);
    expect(resumeRun.calls[0]!.runId).toBe('run-rp-1');
    expect(resumeRun.calls[0]!.fromPhase).toBe('implement');
    expect(resumeRun.calls[0]!.workerId).toBe('w-1');
    expect(resumeRun.calls[0]!.attempt).toBe(1);
  });

  it('increments attempt count when phase was retried before', async () => {
    const runRepo = new FakeRunRepoForRetry();
    runRepo.add(makeFailedRun());
    const resumeRun = new FakeResumeRun();
    const phaseRepo = new FakePhaseRepository();
    phaseRepo.insert({
      id: 'implement',
      runUuid: 'run-rp-1',
      name: 'implement',
      status: 'failed',
      attempt: 1,
    });
    const usecase = new RetryFailedPhase({ runRepository: runRepo, phaseRepo, resumeRun });
    await usecase.execute({ runId: rid('run-rp-1'), workerId: wid('w-1') });
    expect(resumeRun.calls[0]!.attempt).toBe(2);
  });

  it('throws when run is not found', async () => {
    const runRepo = new FakeRunRepoForRetry();
    const usecase = new RetryFailedPhase({
      runRepository: runRepo,
      phaseRepo: new FakePhaseRepository(),
      resumeRun: new FakeResumeRun(),
    });
    await expect(
      usecase.execute({ runId: rid('nonexistent'), workerId: wid('w-1') }),
    ).rejects.toThrow(/no run found/i);
  });

  it('delegates to resumeRun even for non-failed runs (no canResume guard in RetryFailedPhase)', async () => {
    const runRepo = new FakeRunRepoForRetry();
    runRepo.add(makeFailedRun({ status: 'running' }));
    const resumeRun = new FakeResumeRun();
    const usecase = new RetryFailedPhase({
      runRepository: runRepo,
      phaseRepo: new FakePhaseRepository(),
      resumeRun,
    });
    await usecase.execute({ runId: rid('run-rp-1'), workerId: wid('w-1') });
    expect(resumeRun.calls).toHaveLength(1);
    expect(resumeRun.calls[0]!.fromPhase).toBe('implement');
  });

  it('throws when run has no currentPhase', async () => {
    const runRepo = new FakeRunRepoForRetry();
    runRepo.add(makeFailedRun({ currentPhase: undefined }));
    const usecase = new RetryFailedPhase({
      runRepository: runRepo,
      phaseRepo: new FakePhaseRepository(),
      resumeRun: new FakeResumeRun(),
    });
    await expect(usecase.execute({ runId: rid('run-rp-1'), workerId: wid('w-1') })).rejects.toThrow(
      /no current phase/i,
    );
  });
});
