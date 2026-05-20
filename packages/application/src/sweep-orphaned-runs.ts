import type { RunRepositoryPort } from './ports.js';

export interface SweepOrphanedRunsDeps {
  runRepository: RunRepositoryPort;
  isProcessAlive: (pid: number) => boolean;
  now?: () => Date;
}

export class SweepOrphanedRuns {
  constructor(private readonly deps: SweepOrphanedRunsDeps) {}

  execute(): { swept: number } {
    const now = this.deps.now ?? (() => new Date());
    const activeRuns = this.deps.runRepository.findActiveRuns();
    let swept = 0;

    for (const run of activeRuns) {
      if (run.pid === undefined || run.pid === null) {
        continue;
      }
      if (!this.deps.isProcessAlive(run.pid)) {
        const completedAt = now();
        this.deps.runRepository.updateStatusByUuid(run.uuid, {
          status: 'cancelled',
          completedAt,
          failureReason: `orphaned: process ${run.pid} no longer running`,
        });
        swept++;
      }
    }

    return { swept };
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
