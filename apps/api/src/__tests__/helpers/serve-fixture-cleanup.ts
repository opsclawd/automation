import { type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';

export interface TrackedProcess {
  child: ChildProcess;
  pgid: number;
  launcherExited: boolean;
  groupConfirmedGone: boolean;
}

export const trackedChildren = new Map<number, TrackedProcess>();
export const trackedTempDirs = new Set<string>();

/**
 * Registers a spawned ChildProcess and its process group for cleanup.
 *
 * For detached child processes, child.pid is the process-group ID (PGID).
 * Spawning orchestrator.mjs executes cli.ts via execFileSync, so the child
 * recorded by Node is only the launcher, while the Fastify server is its descendant.
 *
 * The process-group identity is retained until cleanup has attempted group termination
 * or until the entire group is confirmed gone (ESRCH), independently of launcher exit.
 */
export function registerChildProcess(child: ChildProcess): void {
  if (child.pid === undefined) return;
  const pgid = child.pid;
  const entry: TrackedProcess = {
    child,
    pgid,
    launcherExited: false,
    groupConfirmedGone: false,
  };
  trackedChildren.set(pgid, entry);

  child.on('exit', () => {
    entry.launcherExited = true;
    // Launcher exit alone is NOT proof that descendant processes in the group have exited.
    // Only remove the group from tracking if the entire process group is confirmed gone.
    try {
      process.kill(-pgid, 0);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        entry.groupConfirmedGone = true;
        trackedChildren.delete(pgid);
      }
    }
  });
}

export function registerTempDirectory(dir: string): void {
  trackedTempDirs.add(dir);
}

/**
 * Idempotent synchronous cleanup routine.
 * Performs best-effort SIGKILL for every still-tracked process group,
 * handles ESRCH / cleanup races safely, and synchronously removes all tracked temp directories.
 *
 * Retains and signals the process group even if launcherExited is true,
 * ensuring surviving descendant servers are terminated.
 */
export function cleanupTrackedResources(): void {
  for (const [pgid, entry] of trackedChildren) {
    if (entry.groupConfirmedGone) {
      continue;
    }
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        // Tolerate cleanup races without masking the test's original failure
      }
    }
    entry.groupConfirmedGone = true;
  }
  trackedChildren.clear();

  for (const dir of trackedTempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Tolerate directory cleanup races without masking the test's original failure
    }
  }
  trackedTempDirs.clear();
}

/**
 * Polls kill(-pgid, 0) until ESRCH is thrown, proving that every process
 * in the process group (including descendants) has fully terminated.
 */
export async function waitForProcessGroupExit(pgid: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(-pgid, 0);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        const entry = trackedChildren.get(pgid);
        if (entry) {
          entry.groupConfirmedGone = true;
          trackedChildren.delete(pgid);
        }
        return;
      }
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for process group ${pgid} to exit`);
}

// Abnormal shutdown handlers for catchable termination signals and process exit
let handlersInstalled = false;

export const onSigTerm = (): void => {
  cleanupTrackedResources();
  process.removeListener('SIGTERM', onSigTerm);
  process.kill(process.pid, 'SIGTERM');
};

export const onSigInt = (): void => {
  cleanupTrackedResources();
  process.removeListener('SIGINT', onSigInt);
  process.kill(process.pid, 'SIGINT');
};

export const onExit = (): void => {
  cleanupTrackedResources();
};

export function installProcessHandlers(): void {
  if (handlersInstalled) return;
  process.on('SIGTERM', onSigTerm);
  process.on('SIGINT', onSigInt);
  process.on('exit', onExit);
  handlersInstalled = true;
}

export function removeProcessHandlers(): void {
  if (!handlersInstalled) return;
  process.removeListener('SIGTERM', onSigTerm);
  process.removeListener('SIGINT', onSigInt);
  process.removeListener('exit', onExit);
  handlersInstalled = false;
}
