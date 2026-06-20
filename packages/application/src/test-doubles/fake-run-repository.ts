import type { Run, RunStatus } from '@ai-sdlc/domain';
import type { RunRecord, RunRepositoryPort, RunRepositoryUpdatePatch } from '../ports.js';

export interface RecordedUpdate {
  uuid: string;
  patch: RunRepositoryUpdatePatch;
}

/**
 * Fake implementation of RunRepositoryPort for testing.
 *
 * NOTE: `findByUuid` returns a live reference to the stored record.
 * Mutating the returned object will also mutate the internal store.
 * If snapshot semantics are needed, return a shallow copy instead.
 */
export class FakeRunRepository implements RunRepositoryPort {
  runs: Map<string, RunRecord> = new Map();
  updates: RecordedUpdate[] = [];

  addRun(r: RunRecord): void {
    this.runs.set(r.uuid, { ...r });
  }

  insertIfNoActive(run: Run): void {
    for (const r of this.runs.values()) {
      if (
        r.issueNumber === run.issueNumber &&
        !['passed', 'failed', 'cancelled'].includes(r.status)
      ) {
        throw new Error(`An active run already exists for issue ${run.issueNumber}`);
      }
    }
    this.runs.set(run.uuid, { ...run } as RunRecord);
  }

  update(uuid: string, patch: RunRepositoryUpdatePatch): void {
    this.updates.push({ uuid, patch });
    const r = this.runs.get(uuid);
    if (!r) return;
    if (patch.status !== undefined) r.status = patch.status;
    if (patch.currentPhase !== undefined) {
      if (patch.currentPhase === null) {
        delete (r as { currentPhase?: unknown }).currentPhase;
      } else {
        r.currentPhase = patch.currentPhase;
      }
    }
    if (patch.completedPhases !== undefined) r.completedPhases = patch.completedPhases;
    if (patch.skippedPhases !== undefined) r.skippedPhases = patch.skippedPhases;
    if (patch.completedAt !== undefined) r.completedAt = patch.completedAt;
    if (patch.failureReason !== undefined) r.failureReason = patch.failureReason;
    if (patch.exitCode !== undefined) r.exitCode = patch.exitCode;
    if (patch.durationMs !== undefined) r.durationMs = patch.durationMs;
  }

  findByUuid(uuid: string): RunRecord | undefined {
    return this.runs.get(uuid);
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
        if (patch.failureReason !== undefined) r.failureReason = patch.failureReason;
        this.updates.push({
          uuid,
          patch: {
            status: patch.status,
            completedAt: patch.completedAt,
            ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
          },
        });
        return true;
      }
    }
    return false;
  }

  updateStatusByUuid(
    uuid: string,
    patch: {
      status: RunStatus;
      completedAt: Date;
      failureReason?: string;
      currentPhase?: string | null;
    },
  ): boolean {
    const r = this.runs.get(uuid);
    if (!r || ['passed', 'failed', 'cancelled'].includes(r.status)) {
      return false;
    }
    r.status = patch.status;
    r.completedAt = patch.completedAt;
    if (patch.currentPhase !== undefined) {
      if (patch.currentPhase === null) {
        delete (r as { currentPhase?: unknown }).currentPhase;
      } else {
        r.currentPhase = patch.currentPhase;
      }
    }
    if (patch.failureReason !== undefined) r.failureReason = patch.failureReason;
    this.updates.push({
      uuid,
      patch: {
        status: patch.status,
        completedAt: patch.completedAt,
        ...(patch.currentPhase !== undefined ? { currentPhase: patch.currentPhase } : {}),
        ...(patch.failureReason !== undefined ? { failureReason: patch.failureReason } : {}),
      },
    });
    return true;
  }

  atomicUpdateByUuid(
    uuid: string,
    patch: RunRepositoryUpdatePatch,
    expectedStatus: RunStatus,
  ): boolean {
    const r = this.runs.get(uuid);
    if (!r || r.status !== expectedStatus) {
      return false;
    }
    if (patch.status !== undefined) r.status = patch.status;
    if (patch.currentPhase !== undefined) {
      if (patch.currentPhase === null) {
        delete (r as { currentPhase?: unknown }).currentPhase;
      } else {
        r.currentPhase = patch.currentPhase;
      }
    }
    if (patch.completedPhases !== undefined) r.completedPhases = patch.completedPhases;
    if (patch.skippedPhases !== undefined) r.skippedPhases = patch.skippedPhases;
    if (patch.completedAt !== undefined) r.completedAt = patch.completedAt;
    if (patch.failureReason !== undefined) r.failureReason = patch.failureReason;
    if (patch.exitCode !== undefined) r.exitCode = patch.exitCode;
    if (patch.durationMs !== undefined) r.durationMs = patch.durationMs;
    this.updates.push({ uuid, patch });
    return true;
  }
}
