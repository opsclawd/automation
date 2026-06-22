import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, findRepoRoot } from '../cli.js';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';
import { RunExecutor } from '@ai-sdlc/application';
import { RunRepository, WorkerLeaseRepository } from '@ai-sdlc/infrastructure';
import { WorkerLeaseConflictError, WorkerId, RepositoryId } from '@ai-sdlc/domain';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(__dirname, '..', '..');
const require = createRequire(join(apiRoot, 'package.json'));
const tsxEsmPath = require.resolve('tsx/esm');
const cliPath = join(apiRoot, 'src', 'cli.ts');

function spawnOrchestrator(args: string[], cwd: string) {
  return spawn('node', ['--conditions=development', '--import', tsxEsmPath, cliPath, ...args], {
    cwd,
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function trackDir<T>(fn: () => T): T {
  const result = fn();
  tempDirs.push(result);
  return result;
}

function fakeScript(exitCode: number): string {
  const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cli-')));
  const path = join(dir, 'run.sh');
  writeFileSync(path, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('findRepoRoot', () => {
  it('walks up to find pnpm-workspace.yaml', () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-root-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const sub = trackDir(() => mkdtempSync(join(root, 'sub-')));
    expect(findRepoRoot(sub)).toBe(root);
  });

  it('falls back to startDir when no pnpm-workspace.yaml is found', () => {
    const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-noroot-')));
    expect(findRepoRoot(dir, () => false)).toBe(dir);
  });
});

describe('CLI run command', () => {
  it('exits 0 on passed run and outputs JSON', async () => {
    const scriptPath = fakeScript(0);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      cbOrEnc?: unknown,
      cb2?: unknown,
    ) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
      if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
      return true;
    }) as never);

    const program = buildProgram();
    await program.parseAsync([
      'node',
      'orchestrator',
      'run',
      '--issue',
      '42',
      '--script',
      scriptPath,
    ]);

    expect(exitSpy).toHaveBeenCalledWith(0);
    const parsed = JSON.parse(writes.join(''));
    expect(parsed.status).toBe('passed');
    expect(parsed.exitCode).toBe(0);
    expect(parsed.uuid).toBeTruthy();

    exitSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('exits 1 on failed run', async () => {
    const scriptPath = fakeScript(7);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      cbOrEnc?: unknown,
      cb2?: unknown,
    ) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
      if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
      return true;
    }) as never);

    const program = buildProgram();
    await program.parseAsync([
      'node',
      'orchestrator',
      'run',
      '--issue',
      '99',
      '--script',
      scriptPath,
    ]);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const parsed = JSON.parse(writes.join(''));
    expect(parsed.status).toBe('failed');
    expect(parsed.exitCode).toBe(7);

    exitSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('missing required --issue causes Commander error mentioning --issue', async () => {
    const program = buildProgram();
    const runCmd = program.commands.find((c) => c.name() === 'run')!;
    runCmd.exitOverride();
    const errs: string[] = [];
    runCmd.configureOutput({ writeErr: (s) => void errs.push(s), writeOut: () => {} });

    await expect(runCmd.parseAsync(['run'], { from: 'user' })).rejects.toThrow(/--issue/);
    expect(errs.join('')).toMatch(/--issue/);
  });

  it('rejects malformed --issue values', async () => {
    for (const bad of ['123abc', '12.5', '-5', 'abc']) {
      const program = buildProgram();
      program.exitOverride();
      await expect(
        program.parseAsync(['node', 'orchestrator', 'run', '--issue', bad]),
      ).rejects.toThrow(/must be a positive integer/gi);
    }
  });

  it('rejects zero as --issue', async () => {
    const program = buildProgram();
    program.exitOverride();
    await expect(
      program.parseAsync(['node', 'orchestrator', 'run', '--issue', '0']),
    ).rejects.toThrow(/must be >= 1/);
  });
});

describe('CLI runs cancel command', () => {
  it('cancels a run by issue number', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cancel-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']);
    await new Promise((r) => setTimeout(r, 50));
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at, pid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'cancel-test-uuid',
      'issue-50-20260519-000000',
      50,
      'issue_to_pr',
      'running',
      '[]',
      new Date().toISOString(),
      child.pid,
    );
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const stdoutChunks: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
      const consoleErrs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const program = buildProgram();
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['cancel', '--issue', '50'], { from: 'user' });
      writeSpy.mockRestore();
      errSpy.mockRestore();
      expect(stdoutChunks.join('')).toMatch(/cancelled successfully/i);
    } finally {
      if (!child.killed) child.kill('SIGKILL');
      process.chdir(savedCwd);
    }
  });

  it('rejects cancel without --issue or --uuid', async () => {
    const program = buildProgram();
    const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
    runsCmd.exitOverride();
    const consoleErrs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((msg) => {
      consoleErrs.push(String(msg));
    });
    await expect(runsCmd.parseAsync(['cancel'], { from: 'user' })).rejects.toThrow();
    expect(consoleErrs.join('')).toMatch(/specify --issue or --uuid/i);
    spy.mockRestore();
  });

  it('cancels a run by uuid using CancelRun use case', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cancel-uuid-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)']);
    await new Promise((r) => setTimeout(r, 50));
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at, pid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'cancel-uuid-test',
      'issue-60-20260519-000000',
      60,
      'issue_to_pr',
      'running',
      '[]',
      new Date().toISOString(),
      child.pid,
    );
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const stdoutChunks: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
      const consoleErrs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const program = buildProgram();
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['cancel', '--uuid', 'cancel-uuid-test'], { from: 'user' });
      writeSpy.mockRestore();
      errSpy.mockRestore();
      expect(stdoutChunks.join('')).toMatch(/cancelled successfully/i);
    } finally {
      if (!child.killed) child.kill('SIGKILL');
      process.chdir(savedCwd);
    }
  });

  it('rejects cancel by uuid when run is already terminal', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cancel-uuid-term-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at, pid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'terminal-uuid',
      'issue-61-20260519-000000',
      61,
      'issue_to_pr',
      'passed',
      '[]',
      new Date().toISOString(),
      null,
    );
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const consoleErrs: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram();
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['cancel', '--uuid', 'terminal-uuid'], { from: 'user' });
      spy.mockRestore();
      exitSpy.mockRestore();
      expect(consoleErrs.join('')).toMatch(/already passed/i);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('rejects cancel by uuid when run not found', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cancel-uuid-nf-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const consoleErrs: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram();
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['cancel', '--uuid', 'nonexistent-uuid'], { from: 'user' });
      spy.mockRestore();
      exitSpy.mockRestore();
      expect(consoleErrs.join('')).toMatch(/no run found/i);
    } finally {
      process.chdir(savedCwd);
    }
  });
});

describe('CLI runs execute command', () => {
  it('runs execute exits 1 when --uuid is missing', async () => {
    const program = buildProgram();
    const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
    const executeCmd = runsCmd.commands.find((c) => c.name() === 'execute')!;
    executeCmd.exitOverride();
    const errs: string[] = [];
    executeCmd.configureOutput({ writeErr: (s) => void errs.push(s), writeOut: () => {} });
    await expect(runsCmd.parseAsync(['execute'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 1,
    });
    expect(errs.join('')).toMatch(/--uuid/i);
  });

  it('runs execute exits 1 when run not found', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-exec-nf-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    writeFileSync(
      join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        validation: { commands: ['echo ok'], timeout: 60 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 3, blockOnSeverity: 'medium' },
          implement: { maxIterations: 3 },
          wholePrFix: { maxIterations: 3 },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        agent: {
          defaultProfile: 'test',
          profiles: {
            test: { runtime: 'opencode', provider: 'test', model: 'test', timeoutMinutes: 1 },
          },
          phaseProfiles: {
            'whole-pr-review': { profile: 'test' },
            'fix-review': { profile: 'test' },
          },
        },
      }),
    );
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const consoleErrs: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram();
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['execute', '--uuid', 'nonexistent-uuid'], { from: 'user' });
      const capturedConsole = consoleErrs.join('');
      const exitCode = exitSpy.mock.calls[0]?.[0];
      spy.mockRestore();
      exitSpy.mockRestore();
      expect(exitCode).toBe(1);
      expect(capturedConsole).toMatch(/no run found/i);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('runs execute succeeds when run status is running (not queued)', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-exec-running-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    writeFileSync(
      join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        validation: { commands: ['echo ok'], timeout: 60 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 3, blockOnSeverity: 'medium' },
          implement: { maxIterations: 3 },
          wholePrFix: { maxIterations: 3 },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        agent: {
          defaultProfile: 'test',
          profiles: {
            test: { runtime: 'opencode', provider: 'test', model: 'test', timeoutMinutes: 1 },
          },
          phaseProfiles: {
            'whole-pr-review': { profile: 'test' },
            'fix-review': { profile: 'test' },
          },
        },
      }),
    );
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    const runUuid = 'test-exec-running-uuid';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-99-20260622-000000',
      99,
      'issue_to_pr',
      'running',
      '[]',
      new Date().toISOString(),
    );
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: {
          uuid: runUuid,
          status: 'passed' as const,
          displayId: 'issue-99-20260622-000000',
          issueNumber: 99,
          type: 'issue_to_pr',
          completedPhases: [],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [],
      });
      const stdoutChunks: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['execute', '--uuid', runUuid], { from: 'user' });
      expect(exitSpy).not.toHaveBeenCalled();
      executeSpy.mockRestore();
      writeSpy.mockRestore();
      exitSpy.mockRestore();
      const output = JSON.parse(stdoutChunks.join(''));
      expect(output.run.uuid).toBe(runUuid);
      expect(output.run.status).toBe('passed');
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('runs execute succeeds and outputs JSON for a valid UUID', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-exec-ok-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    writeFileSync(
      join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        validation: { commands: ['echo ok'], timeout: 60 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 3, blockOnSeverity: 'medium' },
          implement: { maxIterations: 3 },
          wholePrFix: { maxIterations: 3 },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        agent: {
          defaultProfile: 'test',
          profiles: {
            test: { runtime: 'opencode', provider: 'test', model: 'test', timeoutMinutes: 1 },
          },
          phaseProfiles: {
            'whole-pr-review': { profile: 'test' },
            'fix-review': { profile: 'test' },
          },
        },
      }),
    );
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    const runUuid = 'test-exec-ok-uuid';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-99-20260520-000000',
      99,
      'issue_to_pr',
      'queued',
      '[]',
      new Date().toISOString(),
    );
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: {
          uuid: runUuid,
          status: 'passed' as const,
          displayId: '',
          issueNumber: 0,
          type: 'issue_to_pr',
          completedPhases: [],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [
          { phase: 'read_issue', status: 'passed' },
          { phase: 'plan-design', status: 'passed' },
        ],
      });
      const stdoutChunks: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['execute', '--uuid', runUuid], { from: 'user' });

      executeSpy.mockRestore();
      writeSpy.mockRestore();
      const output = JSON.parse(stdoutChunks.join(''));
      expect(output).toHaveProperty('run');
      expect(output.run.uuid).toBe(runUuid);
      expect(output.run.status).toBe('passed');
      expect(output.phases).toBeInstanceOf(Array);
      expect(output.phases).toHaveLength(2);
    } finally {
      process.chdir(savedCwd);
    }
  });
});

describe('CLI run command signal handlers', () => {
  it('marks run as cancelled when process receives SIGTERM', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-sigterm-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const scriptPath = join(root, 'long-running.sh');
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nsleep 60\n');
    chmodSync(scriptPath, 0o755);

    const child = spawnOrchestrator(['run', '--issue', '77', '--script', scriptPath], root);

    const stderr: string[] = [];
    child.stderr?.on('data', (d) => stderr.push(d.toString()));

    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');

    // Wait for the run row to appear (up to 15s)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for run row')), 15_000);
      const poll = () => {
        try {
          const db = openDatabase(dbPath);
          const row = db.prepare('SELECT uuid FROM runs WHERE issue_number = 77').get();
          db.close();
          if (row) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(poll, 200);
          }
        } catch {
          setTimeout(poll, 200);
        }
      };
      poll();
    });

    child.kill('SIGTERM');

    await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    const db = openDatabase(dbPath);
    const run = db
      .prepare('SELECT status, failure_reason FROM runs WHERE issue_number = 77')
      .get() as { status: string; failure_reason: string | null };
    db.close();

    expect(run.status).toBe('cancelled');
    expect(run.failure_reason).toMatch(/interrupted by SIGTERM/i);
  }, 45_000);

  it('marks run as cancelled when process receives SIGINT', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-sigint-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const scriptPath = join(root, 'long-running.sh');
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nsleep 60\n');
    chmodSync(scriptPath, 0o755);

    const child = spawnOrchestrator(['run', '--issue', '78', '--script', scriptPath], root);

    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for run row')), 15_000);
      const poll = () => {
        try {
          const db = openDatabase(dbPath);
          const row = db.prepare('SELECT uuid FROM runs WHERE issue_number = 78').get();
          db.close();
          if (row) {
            clearTimeout(timeout);
            resolve();
          } else {
            setTimeout(poll, 200);
          }
        } catch {
          setTimeout(poll, 200);
        }
      };
      poll();
    });

    child.kill('SIGINT');

    await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    const db = openDatabase(dbPath);
    const run = db
      .prepare('SELECT status, failure_reason FROM runs WHERE issue_number = 78')
      .get() as { status: string; failure_reason: string | null };
    db.close();

    expect(run.status).toBe('cancelled');
    expect(run.failure_reason).toMatch(/interrupted by SIGINT/i);
  }, 45_000);
});

describe('CLI run --executor ts', () => {
  it('exits 1 when RunExecutor is not available (no agent config)', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-noexec-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    // Deliberately no .ai-orchestrator.json — runExecutor will be undefined

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const consoleErrs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram();
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '55',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);
      const exitCode = exitSpy.mock.calls[0]?.[0];
      errSpy.mockRestore();
      exitSpy.mockRestore();
      expect(exitCode).toBe(1);
      expect(consoleErrs.join('')).toMatch(/RunExecutor not available/i);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('exits 1 with friendly message when lease acquisition fails', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-conflict-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    writeFileSync(
      join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        validation: { commands: ['echo ok'], timeout: 60 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 3, blockOnSeverity: 'medium' },
          implement: { maxIterations: 3 },
          wholePrFix: { maxIterations: 3 },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        agent: {
          defaultProfile: 'test',
          profiles: {
            test: { runtime: 'opencode', provider: 'test', model: 'test', timeoutMinutes: 1 },
          },
          phaseProfiles: {
            'whole-pr-review': { profile: 'test' },
            'fix-review': { profile: 'test' },
          },
        },
      }),
    );

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const acquireSpy = vi
        .spyOn(WorkerLeaseRepository.prototype, 'acquire')
        .mockImplementation(() => {
          throw new WorkerLeaseConflictError(
            RepositoryId('owner/repo'),
            WorkerId('existing-worker'),
          );
        });
      const consoleErrs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '56',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);
      const exitCode = exitSpy.mock.calls[0]?.[0];
      acquireSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
      expect(exitCode).toBe(1);
      expect(consoleErrs.join('')).toMatch(/active lease|in progress/i);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('succeeds and outputs JSON when RunExecutor completes', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-ok-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    writeFileSync(
      join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        validation: { commands: ['echo ok'], timeout: 60 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 3, blockOnSeverity: 'medium' },
          implement: { maxIterations: 3 },
          wholePrFix: { maxIterations: 3 },
        },
        timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
        agent: {
          defaultProfile: 'test',
          profiles: {
            test: { runtime: 'opencode', provider: 'test', model: 'test', timeoutMinutes: 1 },
          },
          phaseProfiles: {
            'whole-pr-review': { profile: 'test' },
            'fix-review': { profile: 'test' },
          },
        },
      }),
    );

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const acquireSpy = vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-pid-${process.pid}`),
        runId: 'mock-run-uuid' as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 120_000),
      });
      const heartbeatSpy = vi
        .spyOn(WorkerLeaseRepository.prototype, 'heartbeat')
        .mockReturnValue(undefined);
      const releaseSpy = vi
        .spyOn(WorkerLeaseRepository.prototype, 'release')
        .mockReturnValue(undefined);
      const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: {
          uuid: 'mock-run-uuid',
          status: 'passed' as const,
          displayId: 'issue-57-20260622-000000',
          issueNumber: 57,
          type: 'issue_to_pr',
          completedPhases: ['read-issue'],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [{ phase: 'read-issue', status: 'passed' }],
      });

      const insertSpy = vi.spyOn(RunRepository.prototype, 'insertIfNoActive');

      const stdoutChunks: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '57',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);
      const exitCode = exitSpy.mock.calls[0]?.[0];

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdoutChunks.join(''));
      expect(output.run.status).toBe('passed');
      expect(output.phases).toBeInstanceOf(Array);
      expect(releaseSpy).toHaveBeenCalledOnce(); // lease was released
      expect(insertSpy).toHaveBeenCalledOnce();
      expect(insertSpy.mock.calls[0][0]).toMatchObject({
        issueNumber: 57,
        displayId: expect.any(String),
      });

      acquireSpy.mockRestore();
      heartbeatSpy.mockRestore();
      releaseSpy.mockRestore();
      executeSpy.mockRestore();
      insertSpy.mockRestore();
      writeSpy.mockRestore();
      exitSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });
});
