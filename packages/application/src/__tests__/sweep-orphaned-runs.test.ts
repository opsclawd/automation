import { describe, expect, it } from 'vitest';
import { SweepOrphanedRuns } from '../sweep-orphaned-runs.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';

const fixedNow = () => new Date('2026-05-13T19:23:00Z');

describe('SweepOrphanedRuns', () => {
  it('cancels runs whose PID is dead', () => {
    const repo = new FakeRunRepository();
    repo.addRun({
      uuid: 'orphan-1',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
      pid: 99999,
    });
    const isProcessAlive = (pid: number) => pid !== 99999;
    const usecase = new SweepOrphanedRuns({ runRepository: repo, isProcessAlive, now: fixedNow });
    const result = usecase.execute();
    expect(result.swept).toBe(1);
    expect(repo.updates).toHaveLength(1);
    expect(repo.updates[0]!.patch.status).toBe('cancelled');
    expect(repo.updates[0]!.patch.failureReason).toMatch(/orphaned.*99999/);
  });

  it('skips runs whose PID is still alive', () => {
    const repo = new FakeRunRepository();
    repo.addRun({
      uuid: 'alive-1',
      displayId: 'issue-2-20260513-000000',
      issueNumber: 2,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
      pid: 1234,
    });
    const isProcessAlive = () => true;
    const usecase = new SweepOrphanedRuns({ runRepository: repo, isProcessAlive, now: fixedNow });
    const result = usecase.execute();
    expect(result.swept).toBe(0);
    expect(repo.updates).toHaveLength(0);
  });

  it('skips runs with null PID (pre-migration rows)', () => {
    const repo = new FakeRunRepository();
    repo.addRun({
      uuid: 'old-1',
      displayId: 'issue-3-20260513-000000',
      issueNumber: 3,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
    });
    const isProcessAlive = () => false;
    const usecase = new SweepOrphanedRuns({ runRepository: repo, isProcessAlive, now: fixedNow });
    const result = usecase.execute();
    expect(result.swept).toBe(0);
    expect(repo.updates).toHaveLength(0);
  });

  it('handles empty active runs list', () => {
    const repo = new FakeRunRepository();
    const isProcessAlive = () => false;
    const usecase = new SweepOrphanedRuns({ runRepository: repo, isProcessAlive });
    const result = usecase.execute();
    expect(result.swept).toBe(0);
  });

  it('sweeps multiple orphaned runs', () => {
    const repo = new FakeRunRepository();
    repo.addRun({
      uuid: 'o1',
      displayId: 'issue-10-20260513-000000',
      issueNumber: 10,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
      pid: 111,
    });
    repo.addRun({
      uuid: 'o2',
      displayId: 'issue-11-20260513-000000',
      issueNumber: 11,
      type: 'issue_to_pr',
      status: 'waiting',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
      pid: 222,
    });
    const isProcessAlive = (pid: number) => pid === 111;
    const usecase = new SweepOrphanedRuns({ runRepository: repo, isProcessAlive, now: fixedNow });
    const result = usecase.execute();
    expect(result.swept).toBe(1);
    expect(repo.updates).toHaveLength(1);
    expect(repo.updates[0]!.uuid).toBe('o2');
  });
});
