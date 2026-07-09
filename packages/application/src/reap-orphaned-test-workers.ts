import type { ProcessInfo, ListProcessesPort, KillProcessPort } from './ports.js';

export interface ReapOrphanedTestWorkersDeps {
  listProcesses: ListProcessesPort;
  killProcess: KillProcessPort;
  isOrphanTestWorker?: (proc: ProcessInfo) => boolean;
}

const defaultIsOrphanTestWorker = (proc: ProcessInfo): boolean =>
  proc.ppid === 1 && /node.*vitest\b/.test(proc.cmd);

export class ReapOrphanedTestWorkers {
  constructor(private readonly deps: ReapOrphanedTestWorkersDeps) {}

  execute(): { reaped: number; pids: number[] } {
    const isOrphan = this.deps.isOrphanTestWorker ?? defaultIsOrphanTestWorker;
    const pids: number[] = [];

    for (const proc of this.deps.listProcesses()) {
      if (isOrphan(proc)) {
        try {
          this.deps.killProcess(proc.pid);
          pids.push(proc.pid);
        } catch (err) {
          // Log the failure to kill this specific process and continue reaping others
          console.error(
            `Failed to kill orphaned process ${proc.pid}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    return { reaped: pids.length, pids };
  }
}
