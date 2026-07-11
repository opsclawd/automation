import type { RunRecord, RunRepositoryPort } from './ports.js';

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
  isProcessAlive: (pid: number) => boolean;
  now?: () => Date;
}

export class SweepOrphanedRuns {
  constructor(private readonly deps: SweepOrphanedRunsDeps) {}

  execute(): SweepOrphanedRunsResult {
    const now = this.deps.now ?? (() => new Date());
    const activeRuns = this.deps.runRepository.findActiveRuns();
    const orphanedRuns: SweepOrphanedRunEntry[] = [];

    for (const run of activeRuns) {
      if (run.pid === undefined || run.pid === null) {
        continue;
      }
      if (!this.deps.isProcessAlive(run.pid)) {
        const previousPid = run.pid;
        const previousStatus = run.status;
        const completedAt = now();
        const failureReason = `orphaned: process ${run.pid} no longer running`;
        this.deps.runRepository.updateStatusByUuid(run.uuid, {
          status: 'failed',
          completedAt,
          failureReason,
          currentPhase: null,
        });
        const { currentPhase: _currentPhase, ...runWithoutPhase } = run;
        orphanedRuns.push({
          uuid: run.uuid,
          run: { ...runWithoutPhase, status: 'failed', completedAt, failureReason },
          previousPid,
          previousStatus,
        });
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
