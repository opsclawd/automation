import { describe, expect, it } from 'vitest';
import type { Run, RunStatus } from '@ai-sdlc/domain';
import { SweepOrphanedRuns } from '../sweep-orphaned-runs.js';
import type { RunRecord, RunRepositoryPort, RunRepositoryUpdatePatch } from '../ports.js';

interface RecordedUpdate {
  uuid: string;
  patch: RunRepositoryUpdatePatch;
}

class FakeRunRepo implements RunRepositoryPort {
  runs: Map<string, RunRecord> = new Map();
  updates: RecordedUpdate[] = [];
  insertIfNoActive(_run: Run): void {}
  update(uuid: string, patch: RunRepositoryUpdatePatch): void {
    this.updates.push({ uuid, patch });
  }
  findByIssueNumber(_issueNumber: number): RunRecord | undefined {
    return undefined;
  }
  findActiveRuns(): RunRecord[] {
    return Array.from(this.runs.values()).filter(
      (r) => !['passed', 'failed', 'cancelled'].includes(r.status),
    );
  }
  updateStatusByIssueNumber(
    issueNumber: number,
    patch: { status: RunStatus; completedAt: Date; failureReason?: string },
  ): boolean {
    for (const [uuid, r] of this.runs) {
      if (r.issueNumber === issueNumber && !['passed', 'failed', 'cancelled'].includes(r.status)) {
        r.status = patch.status;
        r.completedAt = patch.completedAt;
        r.failureReason = patch.failureReason;
        this.updates.push({ uuid, patch });
        return true;
      }
    }
    return false;
  }
  addRun(r: RunRecord): void {
    this.runs.set(r.uuid, r);
  }
}

const fixedNow = () => new Date('2026-05-13T19:23:00Z');

describe('SweepOrphanedRuns', () => {
  it('cancels runs whose PID is dead', () => {
    const repo = new FakeRunRepo();
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
    const repo = new FakeRunRepo();
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
    const repo = new FakeRunRepo();
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
    const repo = new FakeRunRepo();
    const isProcessAlive = () => false;
    const usecase = new SweepOrphanedRuns({ runRepository: repo, isProcessAlive });
    const result = usecase.execute();
    expect(result.swept).toBe(0);
  });

  it('sweeps multiple orphaned runs', () => {
    const repo = new FakeRunRepo();
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
