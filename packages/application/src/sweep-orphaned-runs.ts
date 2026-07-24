import type { RunRecord, RunRepositoryPort } from './ports.js';
import type { PhaseRepositoryPort } from './ports/phase-repository-port.js';

export interface SweepOrphanedRunEntry {
  uuid: string;
  run: RunRecord;
  previousPid: number;
  previousStatus: RunRecord['status'];
}

export interface SweepOrphanedRunsResult {
  scanned: number;
  swept: number;
  orphanedRuns: SweepOrphanedRunEntry[];
}

export interface SweepOrphanedRunsDeps {
  runRepository: RunRepositoryPort;
  phaseRepository?: PhaseRepositoryPort;
  isProcessAlive: (pid: number) => boolean;
  now?: () => Date;
}

export class SweepOrphanedRuns {
  constructor(private readonly deps: SweepOrphanedRunsDeps) {}

  reconcile(run: RunRecord): SweepOrphanedRunEntry | undefined {
    if (run.status !== 'running') return undefined;

    const now = this.deps.now ?? (() => new Date());

    if (run.pid === undefined || run.pid === null) {
      return undefined;
    }
    if (this.deps.isProcessAlive(run.pid)) {
      return undefined;
    }

    const previousPid = run.pid;
    const previousStatus = run.status;
    const completedAt = now();
    const failureReason = `orphaned: process ${run.pid} no longer running`;

    const phases = this.deps.phaseRepository?.listByRun(run.uuid) ?? [];
    const latestPhase = phases
      .filter((p) => p.startedAt !== undefined)
      .sort((a, b) => {
        const aTime = a.startedAt!.getTime();
        const bTime = b.startedAt!.getTime();
        if (aTime !== bTime) return bTime - aTime;
        const aCompleted = a.completedAt?.getTime() ?? 0;
        const bCompleted = b.completedAt?.getTime() ?? 0;
        return bCompleted - aCompleted;
      })[0];

    const inferredStatus =
      latestPhase?.completedAt !== undefined &&
      (latestPhase?.status === 'needs_human_review' || latestPhase?.status === 'blocked')
        ? latestPhase.status
        : 'failed';

    const failureReasonToUse =
      inferredStatus === 'blocked' || inferredStatus === 'needs_human_review'
        ? (run.failureReason ?? failureReason)
        : failureReason;

    const updated = this.deps.runRepository.atomicUpdateByUuid(
      run.uuid,
      {
        status: inferredStatus,
        completedAt,
        failureReason: failureReasonToUse,
        currentPhase: null,
      },
      run.status,
    );
    if (!updated) return undefined;

    const { currentPhase: _currentPhase, ...runWithoutPhase } = run;
    return {
      uuid: run.uuid,
      run: {
        ...runWithoutPhase,
        status: inferredStatus,
        completedAt,
        failureReason: failureReasonToUse,
      },
      previousPid,
      previousStatus,
    };
  }

  execute(): SweepOrphanedRunsResult {
    const activeRuns = this.deps.runRepository.findActiveRuns();
    const orphanedRuns: SweepOrphanedRunEntry[] = [];

    for (const run of activeRuns) {
      const entry = this.reconcile(run);
      if (entry) {
        orphanedRuns.push(entry);
      }
    }

    return {
      scanned: activeRuns.length,
      swept: orphanedRuns.length,
      orphanedRuns,
    };
  }
}

export function checkPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}
