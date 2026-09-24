import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  type TrackedProcess,
  trackedChildren,
  trackedTempDirs,
  registerChildProcess,
  registerTempDirectory,
  cleanupTrackedResources,
  waitForProcessGroupExit,
  onSigTerm,
  onSigInt,
  onExit,
  installProcessHandlers,
  removeProcessHandlers,
} from './helpers/serve-fixture-cleanup';

export {
  type TrackedProcess,
  trackedChildren,
  trackedTempDirs,
  registerChildProcess,
  registerTempDirectory,
  cleanupTrackedResources,
  waitForProcessGroupExit,
  onSigTerm,
  onSigInt,
  onExit,
  installProcessHandlers,
  removeProcessHandlers,
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(__dirname, '..', '..');
const orchestratorBin = join(apiRoot, 'bin', 'orchestrator.mjs');
const helperUrl = pathToFileURL(join(__dirname, 'helpers', 'serve-fixture-cleanup.ts')).href;

// Install process handlers on module load as abnormal shutdown backstop
installProcessHandlers();

afterAll(() => {
  removeProcessHandlers();
  cleanupTrackedResources();
});

describe('orchestrator serve startup ([Issue 1214], [Issue 1285])', () => {
  let tempDir: string;

  beforeEach(() => {
    installProcessHandlers();
    tempDir = mkdtempSync(join(tmpdir(), 'ai-orch-serve-test-'));
    registerTempDirectory(tempDir);
  });

  afterEach(() => {
    cleanupTrackedResources();
  });

  it('starts HTTP server without SyntaxError in thread-stream or ajv and serves requests', async () => {
    const dbPath = join(tempDir, 'orchestrator.sqlite');
    const runsDir = join(tempDir, 'runs');

    // Spawn orchestrator.mjs with detached: true so the launcher and its
    // execFileSync('node', ... cli.ts) descendant share a dedicated process group.
    // Signaling -child.pid ensures the entire process tree receives termination signals.
    const child = spawn(
      process.execPath,
      [orchestratorBin, 'serve', '--port', '0', '--db-path', dbPath, '--runs-dir', runsDir],
      {
        cwd: apiRoot,
        env: {
          ...process.env,
          NODE_NO_WARNINGS: '1',
          AI_CLI_TEST_SUITE: 'true',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    registerChildProcess(child);

    let stdoutData = '';
    let stderrData = '';
    let listeningPort: number | undefined;

    const listeningPromise = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for serve startup. Stdout: ${stdoutData}\nStderr: ${stderrData}`,
          ),
        );
      }, 15000);

      const checkOutput = (chunk: string) => {
        const match = chunk.match(/orchestrator API listening on http:\/\/127\.0\.0\.1:(\d+)/);
        if (match && match[1]) {
          clearTimeout(timeout);
          resolve(parseInt(match[1], 10));
        }
      };

      child.stdout?.on('data', (data: Buffer) => {
        const str = data.toString();
        stdoutData += str;
        checkOutput(str);
      });

      child.stderr?.on('data', (data: Buffer) => {
        const str = data.toString();
        stderrData += str;
        checkOutput(str);
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      child.on('exit', (code, signal) => {
        clearTimeout(timeout);
        if (listeningPort === undefined) {
          reject(
            new Error(
              `Child exited prematurely with code ${code}, signal ${signal}.\nStdout: ${stdoutData}\nStderr: ${stderrData}`,
            ),
          );
        }
      });
    });

    listeningPort = await listeningPromise;
    expect(listeningPort).toBeGreaterThan(0);

    // Verify stderr does not contain JSON parse errors from tsx loader corruption
    expect(stderrData).not.toContain('SyntaxError');
    expect(stderrData).not.toContain('is not valid JSON');

    // Make an HTTP request to verify the server is live and responsive
    const res = await fetch(`http://127.0.0.1:${listeningPort}/api/runs`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: unknown[]; total: number };
    expect(Array.isArray(body.runs)).toBe(true);
    expect(body.total).toBe(0);

    // Verify graceful shutdown via SIGINT sent to the process group
    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    expect(child.pid).toBeDefined();
    const pgid = child.pid!;

    // Send SIGINT to negative PID (entire process group) so both launcher and server receive it
    process.kill(-pgid, 'SIGINT');

    const exitResult = await Promise.race([
      exitPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for child process to exit')), 10000),
      ),
    ]);
    expect(exitResult.code === 0 || exitResult.signal === 'SIGINT').toBe(true);

    // Verify server and full process group actually terminated (launcher exit alone is not proof)
    await waitForProcessGroupExit(pgid, 10000);

    // Verify server is no longer accepting requests
    await expect(fetch(`http://127.0.0.1:${listeningPort}/api/runs`)).rejects.toThrow();
  }, 30000);
});

describe('startup fixture process-tree and directory cleanup ([Issue 1285])', () => {
  beforeEach(() => {
    installProcessHandlers();
  });

  afterEach(() => {
    cleanupTrackedResources();
  });

  it('idempotently cleans up live process groups and temporary directories', async () => {
    const dummyDir = mkdtempSync(join(tmpdir(), 'ai-orch-dummy-dir-'));
    registerTempDirectory(dummyDir);
    expect(existsSync(dummyDir)).toBe(true);

    const dummyChild = spawn('sleep', ['60'], { detached: true });
    registerChildProcess(dummyChild);
    expect(dummyChild.pid).toBeDefined();
    const dummyPgid = dummyChild.pid!;

    // Verify dummy process group exists
    expect(() => process.kill(-dummyPgid, 0)).not.toThrow();

    // Perform cleanup
    cleanupTrackedResources();

    expect(trackedChildren.size).toBe(0);
    expect(trackedTempDirs.size).toBe(0);
    expect(existsSync(dummyDir)).toBe(false);

    // Process group was signaled SIGKILL and is gone
    await waitForProcessGroupExit(dummyPgid, 2000);

    // Repeated cleanup is harmless and idempotent
    expect(() => cleanupTrackedResources()).not.toThrow();
  });

  it('cleans up surviving process group descendants when the launcher exits prematurely', async () => {
    // Spawn a launcher that launches a background descendant in the same process group
    // and exits immediately (simulating orchestrator launcher crash/exit while server lives)
    const launcher = spawn(
      process.execPath,
      [
        '-e',
        'import("node:child_process").then(cp => { cp.spawn("sleep", ["60"], { stdio: "ignore" }); setTimeout(() => process.exit(0), 50); });',
      ],
      {
        stdio: 'ignore',
        detached: true,
      },
    );
    registerChildProcess(launcher);
    expect(launcher.pid).toBeDefined();
    const pgid = launcher.pid!;

    // Wait for the launcher process itself to exit
    await new Promise<void>((resolve) => {
      launcher.on('exit', () => resolve());
    });
    expect(launcher.exitCode).toBe(0);

    // The launcher has exited, but the process group identity MUST still be retained
    // because the descendant is still alive in the same process group.
    expect(trackedChildren.has(pgid)).toBe(true);
    expect(trackedChildren.get(pgid)?.launcherExited).toBe(true);
    expect(trackedChildren.get(pgid)?.groupConfirmedGone).toBe(false);

    // Verify the descendant is indeed still running in the process group
    expect(() => process.kill(-pgid, 0)).not.toThrow();

    // Now invoke cleanup - it must signal the surviving process group even though launcher exited
    cleanupTrackedResources();

    expect(trackedChildren.size).toBe(0);

    // Verify that the surviving descendant process in the process group was killed
    await waitForProcessGroupExit(pgid, 2000);
  });

  it('skips signaling process groups that are already confirmed gone', () => {
    const killSpy = vi.spyOn(process, 'kill');
    const exitedChild = {
      pid: 99999998,
      exitCode: 0,
      signalCode: null,
      on: () => exitedChild,
    } as unknown as ChildProcess;

    trackedChildren.set(99999998, {
      child: exitedChild,
      pgid: 99999998,
      launcherExited: true,
      groupConfirmedGone: true,
    });
    expect(() => cleanupTrackedResources()).not.toThrow();
    expect(trackedChildren.size).toBe(0);
    expect(killSpy).not.toHaveBeenCalledWith(-99999998, 'SIGKILL');
    killSpy.mockRestore();
  });

  it('handles ESRCH gracefully when process group has already exited', () => {
    const nonExistentPgid = 99999997;
    const nonExistentChild = {
      pid: nonExistentPgid,
      exitCode: null,
      signalCode: null,
      on: () => nonExistentChild,
    } as unknown as ChildProcess;

    trackedChildren.set(nonExistentPgid, {
      child: nonExistentChild,
      pgid: nonExistentPgid,
      launcherExited: false,
      groupConfirmedGone: false,
    });
    expect(() => cleanupTrackedResources()).not.toThrow();
    expect(trackedChildren.size).toBe(0);
  });

  it('manages signal listener lifecycle idempotently', () => {
    const initialSigTerm = process.listenerCount('SIGTERM');
    const initialSigInt = process.listenerCount('SIGINT');
    const initialExit = process.listenerCount('exit');

    // install is singular/idempotent
    installProcessHandlers();
    expect(process.listenerCount('SIGTERM')).toBe(initialSigTerm);

    removeProcessHandlers();
    expect(process.listenerCount('SIGTERM')).toBe(initialSigTerm - 1);
    expect(process.listenerCount('SIGINT')).toBe(initialSigInt - 1);
    expect(process.listenerCount('exit')).toBe(initialExit - 1);

    // restore handlers
    installProcessHandlers();
    expect(process.listenerCount('SIGTERM')).toBe(initialSigTerm);
  });

  it('synchronously cleans up process group and temp directory on SIGTERM in an isolated subprocess', async () => {
    const workerScript = `
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installProcessHandlers,
  registerChildProcess,
  registerTempDirectory,
} from ${JSON.stringify(helperUrl)};

installProcessHandlers();

const tempDir = mkdtempSync(join(tmpdir(), "worker-test-term-"));
registerTempDirectory(tempDir);

const child = spawn("sleep", ["60"], { detached: true });
registerChildProcess(child);

console.log(JSON.stringify({ pid: child.pid, tempDir }));
setInterval(() => {}, 1000);
`;

    const worker = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', workerScript],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let meta: { pid: number; tempDir: string } | undefined;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for worker output')),
        5000,
      );
      worker.stdout?.on('data', (d) => {
        clearTimeout(timer);
        meta = JSON.parse(d.toString().trim());
        resolve();
      });
      worker.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(meta).toBeDefined();

    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      worker.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    worker.kill('SIGTERM');
    const exitResult = await exitPromise;
    expect(exitResult.signal).toBe('SIGTERM');

    // Verify background child process group was killed
    await waitForProcessGroupExit(meta!.pid, 2000);

    // Verify temp directory was removed
    expect(existsSync(meta!.tempDir)).toBe(false);
  });

  it('synchronously cleans up process group and temp directory on SIGINT in an isolated subprocess', async () => {
    const workerScript = `
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installProcessHandlers,
  registerChildProcess,
  registerTempDirectory,
} from ${JSON.stringify(helperUrl)};

installProcessHandlers();

const tempDir = mkdtempSync(join(tmpdir(), "worker-test-int-"));
registerTempDirectory(tempDir);

const child = spawn("sleep", ["60"], { detached: true });
registerChildProcess(child);

console.log(JSON.stringify({ pid: child.pid, tempDir }));
setInterval(() => {}, 1000);
`;

    const worker = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', workerScript],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let meta: { pid: number; tempDir: string } | undefined;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for worker output')),
        5000,
      );
      worker.stdout?.on('data', (d) => {
        clearTimeout(timer);
        meta = JSON.parse(d.toString().trim());
        resolve();
      });
      worker.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(meta).toBeDefined();

    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      worker.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    worker.kill('SIGINT');
    const exitResult = await exitPromise;
    expect(exitResult.signal).toBe('SIGINT');

    // Verify background child process group was killed
    await waitForProcessGroupExit(meta!.pid, 2000);

    // Verify temp directory was removed
    expect(existsSync(meta!.tempDir)).toBe(false);
  });

  it('synchronously cleans up process group and temp directory on process exit in an isolated subprocess', async () => {
    const workerScript = `
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installProcessHandlers,
  registerChildProcess,
  registerTempDirectory,
} from ${JSON.stringify(helperUrl)};

installProcessHandlers();

const tempDir = mkdtempSync(join(tmpdir(), "worker-test-exit-"));
registerTempDirectory(tempDir);

const child = spawn("sleep", ["60"], { detached: true });
registerChildProcess(child);

console.log(JSON.stringify({ pid: child.pid, tempDir }));
process.exit(0);
`;

    const worker = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', workerScript],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let meta: { pid: number; tempDir: string } | undefined;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for worker output')),
        5000,
      );
      worker.stdout?.on('data', (d) => {
        clearTimeout(timer);
        meta = JSON.parse(d.toString().trim());
        resolve();
      });
      worker.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(meta).toBeDefined();

    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      worker.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    const exitResult = await exitPromise;
    expect(exitResult.code).toBe(0);

    // Verify background child process group was killed
    await waitForProcessGroupExit(meta!.pid, 2000);

    // Verify temp directory was removed
    expect(existsSync(meta!.tempDir)).toBe(false);
  });

  it('synchronously cleans up surviving process group descendants on SIGTERM when launcher exited', async () => {
    const workerScript = `
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installProcessHandlers,
  registerChildProcess,
  registerTempDirectory,
} from ${JSON.stringify(helperUrl)};

installProcessHandlers();

const tempDir = mkdtempSync(join(tmpdir(), "worker-test-descendant-term-"));
registerTempDirectory(tempDir);

// Spawn a launcher that launches a descendant in the same group and exits immediately
const launcher = spawn(
  process.execPath,
  [
    '-e',
    'import("node:child_process").then(cp => { cp.spawn("sleep", ["60"], { stdio: "ignore" }); setTimeout(() => process.exit(0), 50); });',
  ],
  {
    stdio: "ignore",
    detached: true,
  },
);
registerChildProcess(launcher);

launcher.on("exit", () => {
  // Launcher has exited, but descendant process in group is still running
  console.log(JSON.stringify({ pid: launcher.pid, tempDir }));
});

setInterval(() => {}, 1000);
`;

    const worker = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', workerScript],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let meta: { pid: number; tempDir: string } | undefined;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for worker output')),
        5000,
      );
      worker.stdout?.on('data', (d) => {
        clearTimeout(timer);
        meta = JSON.parse(d.toString().trim());
        resolve();
      });
      worker.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(meta).toBeDefined();

    // Verify descendant is alive in the group even though launcher exited
    expect(() => process.kill(-meta!.pid, 0)).not.toThrow();

    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      worker.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    worker.kill('SIGTERM');
    const exitResult = await exitPromise;
    expect(exitResult.signal).toBe('SIGTERM');

    // Verify surviving descendant in process group was killed by worker's onSigTerm
    await waitForProcessGroupExit(meta!.pid, 2000);

    // Verify temp directory was removed
    expect(existsSync(meta!.tempDir)).toBe(false);
  });
});
