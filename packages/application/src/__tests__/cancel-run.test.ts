import { describe, expect, it } from 'vitest';
import type { Run, RunStatus } from '@ai-sdlc/domain';
import { CancelRun } from '../cancel-run.js';
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
  findByIssueNumber(issueNumber: number): RunRecord | undefined {
    let latest: RunRecord | undefined;
    for (const r of this.runs.values()) {
      if (r.issueNumber === issueNumber) {
        if (!latest || r.startedAt > latest.startedAt) {
          latest = r;
        }
      }
    }
    return latest;
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
        this.updates.push({
          uuid,
          patch: {
            status: patch.status,
            completedAt: patch.completedAt,
            ...(patch.failureReason ? { failureReason: patch.failureReason } : {}),
          },
        });
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

describe('CancelRun', () => {
  it('cancels an active run by issue number', () => {
    const repo = new FakeRunRepo();
    repo.addRun({
      uuid: 'abc-123',
      displayId: 'issue-7-20260513-000000',
      issueNumber: 7,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T19:00:00Z'),
    });
    const usecase = new CancelRun({ runRepository: repo, now: fixedNow });
    usecase.execute({ issueNumber: 7, reason: 'user requested' });
    expect(repo.updates).toHaveLength(1);
    expect(repo.updates[0]!.patch.status).toBe('cancelled');
    expect(repo.updates[0]!.patch.failureReason).toBe('user requested');
    expect(repo.updates[0]!.patch.completedAt).toEqual(fixedNow());
  });

  it('throws when no active run exists for the issue', () => {
    const repo = new FakeRunRepo();
    const usecase = new CancelRun({ runRepository: repo });
    expect(() => usecase.execute({ issueNumber: 99 })).toThrow(/no active run/i);
  });

  it('throws when the run is already terminal', () => {
    const repo = new FakeRunRepo();
    repo.addRun({
      uuid: 'abc-456',
      displayId: 'issue-3-20260513-000000',
      issueNumber: 3,
      type: 'issue_to_pr',
      status: 'passed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T19:00:00Z'),
    });
    const usecase = new CancelRun({ runRepository: repo });
    expect(() => usecase.execute({ issueNumber: 3 })).toThrow(/already passed/i);
  });

  it('cancels without a reason', () => {
    const repo = new FakeRunRepo();
    repo.addRun({
      uuid: 'abc-789',
      displayId: 'issue-10-20260513-000000',
      issueNumber: 10,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T19:00:00Z'),
    });
    const usecase = new CancelRun({ runRepository: repo, now: fixedNow });
    usecase.execute({ issueNumber: 10 });
    expect(repo.updates[0]!.patch.failureReason).toBeUndefined();
  });
});
