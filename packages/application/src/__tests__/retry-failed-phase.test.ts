import { describe, expect, it } from 'vitest';
import type { RunId, WorkerId } from '@ai-sdlc/domain';
import { RetryFailedPhase } from '../retry-failed-phase.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';
import type { RunRecord } from '../ports.js';
import { FakeResumeRun } from '../test-doubles/fake-resume-run.js';
import { FakePhaseRepository } from '../test-doubles/fake-phase-repository.js';

const wid = (s: string) => s as WorkerId;
const rid = (s: string) => s as RunId;

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
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeFailedRun());
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
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeFailedRun());
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
    const runRepo = new FakeRunRepository();
    const usecase = new RetryFailedPhase({
      runRepository: runRepo,
      phaseRepo: new FakePhaseRepository(),
      resumeRun: new FakeResumeRun(),
    });
    await expect(
      usecase.execute({ runId: rid('nonexistent'), workerId: wid('w-1') }),
    ).rejects.toThrow(/no run found/i);
  });

  it('throws when run is not recoverable', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeFailedRun({ status: 'running' }));
    const resumeRun = new FakeResumeRun();
    const usecase = new RetryFailedPhase({
      runRepository: runRepo,
      phaseRepo: new FakePhaseRepository(),
      resumeRun,
    });
    await expect(usecase.execute({ runId: rid('run-rp-1'), workerId: wid('w-1') })).rejects.toThrow(
      /expected 'failed', 'blocked', or 'needs_human_review'/i,
    );
    expect(resumeRun.calls).toHaveLength(0);
  });

  it('derives phase from phase records when run.currentPhase is undefined', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeFailedRun({ currentPhase: undefined }));
    const resumeRun = new FakeResumeRun();
    const phaseRepo = new FakePhaseRepository();
    phaseRepo.insert({
      id: 'implement',
      runUuid: 'run-rp-1',
      name: 'implement',
      status: 'failed',
      attempt: 1,
      startedAt: new Date('2026-06-01T00:00:00Z'),
      completedAt: new Date('2026-06-01T01:00:00Z'),
    });
    const usecase = new RetryFailedPhase({ runRepository: runRepo, phaseRepo, resumeRun });
    await usecase.execute({ runId: rid('run-rp-1'), workerId: wid('w-1') });
    expect(resumeRun.calls).toHaveLength(1);
    expect(resumeRun.calls[0]!.fromPhase).toBe('implement');
    expect(resumeRun.calls[0]!.attempt).toBe(2);
  });

  it('derives phase from needs_human_review phase records when run.currentPhase is undefined', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeFailedRun({ status: 'needs_human_review', currentPhase: undefined }));
    const resumeRun = new FakeResumeRun();
    const phaseRepo = new FakePhaseRepository();
    phaseRepo.insert({
      id: 'implement',
      runUuid: 'run-rp-1',
      name: 'implement',
      status: 'needs_human_review',
      attempt: 1,
      startedAt: new Date('2026-06-01T00:00:00Z'),
      completedAt: new Date('2026-06-01T01:00:00Z'),
    });
    const usecase = new RetryFailedPhase({ runRepository: runRepo, phaseRepo, resumeRun });
    await usecase.execute({ runId: rid('run-rp-1'), workerId: wid('w-1') });
    expect(resumeRun.calls).toHaveLength(1);
    expect(resumeRun.calls[0]!.fromPhase).toBe('implement');
    expect(resumeRun.calls[0]!.attempt).toBe(2);
  });

  it('derives phase from blocked phase records when run.currentPhase is undefined', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeFailedRun({ status: 'blocked', currentPhase: undefined }));
    const resumeRun = new FakeResumeRun();
    const phaseRepo = new FakePhaseRepository();
    phaseRepo.insert({
      id: 'implement',
      runUuid: 'run-rp-1',
      name: 'implement',
      status: 'blocked',
      attempt: 1,
      startedAt: new Date('2026-06-01T00:00:00Z'),
      completedAt: new Date('2026-06-01T01:00:00Z'),
    });
    const usecase = new RetryFailedPhase({ runRepository: runRepo, phaseRepo, resumeRun });
    await usecase.execute({ runId: rid('run-rp-1'), workerId: wid('w-1') });
    expect(resumeRun.calls).toHaveLength(1);
    expect(resumeRun.calls[0]!.fromPhase).toBe('implement');
    expect(resumeRun.calls[0]!.attempt).toBe(2);
  });

  it('throws when run has no currentPhase and no recoverable phase records', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeFailedRun({ status: 'blocked', currentPhase: undefined }));
    const usecase = new RetryFailedPhase({
      runRepository: runRepo,
      phaseRepo: new FakePhaseRepository(),
      resumeRun: new FakeResumeRun(),
    });
    await expect(usecase.execute({ runId: rid('run-rp-1'), workerId: wid('w-1') })).rejects.toThrow(
      /no current phase/i,
    );
  });

  it('treats empty-string currentPhase as absent and falls back to phase records', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeFailedRun({ currentPhase: '' }));
    const resumeRun = new FakeResumeRun();
    const phaseRepo = new FakePhaseRepository();
    phaseRepo.insert({
      id: 'implement',
      runUuid: 'run-rp-1',
      name: 'implement',
      status: 'failed',
      attempt: 1,
      startedAt: new Date('2026-06-01T00:00:00Z'),
      completedAt: new Date('2026-06-01T01:00:00Z'),
    });
    const usecase = new RetryFailedPhase({ runRepository: runRepo, phaseRepo, resumeRun });
    await usecase.execute({ runId: rid('run-rp-1'), workerId: wid('w-1') });
    expect(resumeRun.calls).toHaveLength(1);
    expect(resumeRun.calls[0]!.fromPhase).toBe('implement');
  });

  it('throws when currentPhase is empty string and phases table is also empty', async () => {
    const runRepo = new FakeRunRepository();
    runRepo.addRun(makeFailedRun({ currentPhase: '' }));
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
