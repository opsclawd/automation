import type { Run, RunStatus, RepositoryId } from '@ai-sdlc/domain';
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
        r.repoId === run.repoId &&
        r.issueNumber === run.issueNumber &&
        !['passed', 'failed', 'cancelled'].includes(r.status)
      ) {
        throw new Error(
          `An active run already exists for repository ${run.repoId} issue ${run.issueNumber}`,
        );
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
    if (patch.completedAt !== undefined) {
      if (patch.completedAt === null) {
        delete (r as { completedAt?: unknown }).completedAt;
      } else {
        r.completedAt = patch.completedAt;
      }
    }
    if (patch.failureReason !== undefined) {
      if (patch.failureReason === null) {
        delete (r as { failureReason?: unknown }).failureReason;
      } else {
        r.failureReason = patch.failureReason;
      }
    }
    if (patch.exitCode !== undefined) r.exitCode = patch.exitCode;
    if (patch.durationMs !== undefined) r.durationMs = patch.durationMs;
    if (patch.startCommitSha !== undefined) r.startCommitSha = patch.startCommitSha;
    if (patch.pid !== undefined) r.pid = patch.pid;
  }

  findByUuid(uuid: string): RunRecord | undefined {
    return this.runs.get(uuid);
  }

  findByIssueNumber(repoId: RepositoryId | number, issueNumber?: number): RunRecord | undefined {
    if (typeof repoId === 'number') {
      const actualIssueNumber = repoId;
      let latest: RunRecord | undefined;
      for (const r of this.runs.values()) {
        if (r.issueNumber === actualIssueNumber) {
          if (!latest || r.startedAt > latest.startedAt) {
            latest = r;
          }
        }
      }
      return latest;
    }
    let latest: RunRecord | undefined;
    for (const r of this.runs.values()) {
      if (r.repoId === repoId && r.issueNumber === issueNumber) {
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
  ): boolean;
  updateStatusByIssueNumber(
    repoId: RepositoryId,
    issueNumber: number,
    patch: { status: RunStatus; completedAt: Date; failureReason?: string },
  ): boolean;
  updateStatusByIssueNumber(
    repoIdOrIssueNumber: RepositoryId | number,
    issueNumberOrPatch?: number | { status: RunStatus; completedAt: Date; failureReason?: string },
    maybePatch?: { status: RunStatus; completedAt: Date; failureReason?: string },
  ): boolean {
    if (typeof repoIdOrIssueNumber === 'number') {
      const actualIssueNumber = repoIdOrIssueNumber;
      const actualPatch = issueNumberOrPatch as
        | {
            status: RunStatus;
            completedAt: Date;
            failureReason?: string;
          }
        | undefined;
      if (!actualPatch) {
        throw new Error('Missing patch argument for updateStatusByIssueNumber');
      }
      for (const [uuid, r] of this.runs) {
        if (
          r.issueNumber === actualIssueNumber &&
          !['passed', 'failed', 'cancelled'].includes(r.status)
        ) {
          r.status = actualPatch.status;
          r.completedAt = actualPatch.completedAt;
          if (actualPatch.failureReason !== undefined) r.failureReason = actualPatch.failureReason;
          this.updates.push({
            uuid,
            patch: {
              status: actualPatch.status,
              completedAt: actualPatch.completedAt,
              ...(actualPatch.failureReason !== undefined
                ? { failureReason: actualPatch.failureReason }
                : {}),
            },
          });
          return true;
        }
      }
      return false;
    }

    if (typeof issueNumberOrPatch !== 'number') {
      throw new Error('Invalid or missing issueNumber argument for updateStatusByIssueNumber');
    }
    if (!maybePatch) {
      throw new Error('Missing patch argument for updateStatusByIssueNumber');
    }

    const actualIssueNumber = issueNumberOrPatch;
    const actualPatch = maybePatch;
    for (const [uuid, r] of this.runs) {
      if (
        r.repoId === repoIdOrIssueNumber &&
        r.issueNumber === actualIssueNumber &&
        !['passed', 'failed', 'cancelled'].includes(r.status)
      ) {
        r.status = actualPatch.status;
        r.completedAt = actualPatch.completedAt;
        if (actualPatch.failureReason !== undefined) r.failureReason = actualPatch.failureReason;
        this.updates.push({
          uuid,
          patch: {
            status: actualPatch.status,
            completedAt: actualPatch.completedAt,
            ...(actualPatch.failureReason !== undefined
              ? { failureReason: actualPatch.failureReason }
              : {}),
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
    if (patch.completedAt !== undefined) {
      if (patch.completedAt === null) {
        delete (r as { completedAt?: unknown }).completedAt;
      } else {
        r.completedAt = patch.completedAt;
      }
    }
    if (patch.failureReason !== undefined) {
      if (patch.failureReason === null) {
        delete (r as { failureReason?: unknown }).failureReason;
      } else {
        r.failureReason = patch.failureReason;
      }
    }
    if (patch.exitCode !== undefined) r.exitCode = patch.exitCode;
    if (patch.durationMs !== undefined) r.durationMs = patch.durationMs;
    if (patch.startCommitSha !== undefined) r.startCommitSha = patch.startCommitSha;
    if (patch.pid !== undefined) r.pid = patch.pid;
    this.updates.push({ uuid, patch });
    return true;
  }
}
