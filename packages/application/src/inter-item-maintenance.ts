import type { GitPort } from './ports/git-port.js';
import type { EnvironmentHealthPort } from './ports/environment-health-port.js';

export interface InterItemMaintenanceDeps {
  git: GitPort;
  health: EnvironmentHealthPort;
  orphanReaper?: { execute: () => { reaped: number; pids: number[] } };
  cleanupTemp?: (runUuid: string) => Promise<void> | void;
  minDiskFreeMb?: number;
  minMemoryAvailableMb?: number;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string, err?: unknown) => void;
  };
}

export interface MaintenanceInput {
  repoLocalBasePath: string;
  completedIssueNumber: number;
  completedRunUuid?: string | undefined;
}

export interface MaintenanceResult {
  success: boolean;
  reason?: string;
  reapedProcesses: number;
  worktreeRemoved: boolean;
}

export class InterItemMaintenanceService {
  constructor(private readonly deps: InterItemMaintenanceDeps) {}

  async execute(input: MaintenanceInput): Promise<MaintenanceResult> {
    // 1. Process cleanup: reap orphaned test workers (PPID 1 vitest/node)
    let reapedProcesses = 0;
    if (this.deps.orphanReaper) {
      try {
        const reap = this.deps.orphanReaper.execute();
        reapedProcesses = reap.reaped;
        if (reapedProcesses > 0) {
          this.deps.logger?.info?.(
            `Inter-item maintenance reaped ${reapedProcesses} process(es): ${reap.pids.join(', ')}`,
          );
        }
      } catch (err) {
        this.deps.logger?.warn?.(
          `Process reaping failed during maintenance: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 2. Worktree cleanup: remove completed item's worktree according to lifecycle rules
    let worktreeRemoved = false;
    const worktreePath = `${input.repoLocalBasePath}/.ai-worktrees/issue-${input.completedIssueNumber}`;
    try {
      await this.deps.git.removeWorktree(worktreePath);
      worktreeRemoved = true;
    } catch (err) {
      // Non-fatal if already removed or not present
      this.deps.logger?.warn?.(
        `Worktree removal for ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 3. Stale temp cleanup: remove completed Run's temp directory
    if (input.completedRunUuid && this.deps.cleanupTemp) {
      try {
        await this.deps.cleanupTemp(input.completedRunUuid);
      } catch (err) {
        this.deps.logger?.warn?.(
          `Temp cleanup for run ${input.completedRunUuid}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 4. Deterministic environment health threshold check (disk free space & memory)
    const minDiskFreeMb = this.deps.minDiskFreeMb ?? 2048;
    const minMemoryAvailableMb = this.deps.minMemoryAvailableMb ?? 4096;

    const health = await this.deps.health.checkHealth({
      minDiskFreeMb,
      minMemoryAvailableMb,
      targetPath: input.repoLocalBasePath,
    });

    if (!health.healthy) {
      const reason = health.reason ?? 'environment_unhealthy';
      this.deps.logger?.warn?.(`Inter-item maintenance health check failed: ${reason}`);
      return {
        success: false,
        reason,
        reapedProcesses,
        worktreeRemoved,
      };
    }

    return {
      success: true,
      reapedProcesses,
      worktreeRemoved,
    };
  }
}
