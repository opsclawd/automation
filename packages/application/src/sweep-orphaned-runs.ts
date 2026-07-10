import type { RunRecord, RunRepositoryPort, WorkerLeasePort } from './ports.js';

export interface SweepOrphanedRunsDeps {
  runRepository: RunRepositoryPort;
  isProcessAlive: (pid: number) => boolean;
  leasePort?: WorkerLeasePort;
  now?: () => Date;
}

export interface SweepOrphanedRunsResult {
  swept: number;
  sweptRuns: RunRecord[];
}

export class SweepOrphanedRuns {
  constructor(private readonly deps: SweepOrphanedRunsDeps) {}

  execute(): SweepOrphanedRunsResult {
    const now = this.deps.now ?? (() => new Date());
    const activeRuns = this.deps.runRepository.findActiveRuns();
    const sweptRuns: RunRecord[] = [];
    let swept = 0;

    for (const run of activeRuns) {
      if (run.pid === undefined || run.pid === null) {
        continue;
      }

      // Respect worker leases — a run whose lease is still held by a live
      // process (potentially on another host) must not be swept.
      if (this.deps.leasePort?.checkActiveLease(run.repoId, now())) {
        continue;
      }

      if (!this.deps.isProcessAlive(run.pid)) {
        const completedAt = now();
        const patch = {
          status: 'failed' as const,
          completedAt,
          failureReason: `orphaned: process ${run.pid} no longer running`,
          currentPhase: null,
        };
        this.deps.runRepository.updateStatusByUuid(run.uuid, patch);
        const { currentPhase: _cp, ...rest } = run;
        void _cp;
        sweptRuns.push({ ...rest, ...patch, currentPhase: undefined } as unknown as RunRecord);
        swept++;
      }
    }

    return { swept, sweptRuns };
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
