import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(__dirname, '..', '..');
const orchestratorBin = join(apiRoot, 'bin', 'orchestrator.mjs');

describe('orchestrator serve startup ([Issue 1214])', () => {
  let tempDir: string;
  const childProcesses: ChildProcess[] = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-orch-serve-test-'));
  });

  afterEach(async () => {
    for (const child of childProcesses) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    childProcesses.length = 0;
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('starts HTTP server without SyntaxError in thread-stream or ajv and serves requests', async () => {
    const dbPath = join(tempDir, 'orchestrator.sqlite');
    const runsDir = join(tempDir, 'runs');

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
      },
    );
    childProcesses.push(child);

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

    // Verify graceful shutdown via SIGINT
    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on('exit', (code, signal) => {
        resolve({ code, signal });
      });
    });

    child.kill('SIGINT');
    const exitResult = await exitPromise;
    expect(exitResult.code === 0 || exitResult.signal === 'SIGINT').toBe(true);
  }, 20000);
});
