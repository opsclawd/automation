import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, findRepoRoot } from '../cli.js';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';
import { RunExecutor, ResumeRun, RetryFailedPhase } from '@ai-sdlc/application';
import {
  GitWorktreeAdapter,
  InMemoryEventBus,
  RunRepository,
  WorkerLeaseRepository,
} from '@ai-sdlc/infrastructure';
import { WorkerLeaseConflictError, WorkerId, RepositoryId } from '@ai-sdlc/domain';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(__dirname, '..', '..');
const require = createRequire(join(apiRoot, 'package.json'));
const tsxEsmPath = require.resolve('tsx/esm');
const cliPath = join(apiRoot, 'src', 'cli.ts');

function spawnOrchestrator(args: string[], cwd: string, envOverrides?: Record<string, string>) {
  return spawn('node', ['--conditions=development', '--import', tsxEsmPath, cliPath, ...args], {
    cwd,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...envOverrides },
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
      const acquireSpy = vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-${process.pid}`),
        runId: runUuid as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
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
      acquireSpy.mockRestore();
      heartbeatSpy.mockRestore();
      releaseSpy.mockRestore();
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
      const acquireSpy = vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-${process.pid}`),
        runId: runUuid as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
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
      const stdoutChunks: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['execute', '--uuid', runUuid], { from: 'user' });

      acquireSpy.mockRestore();
      heartbeatSpy.mockRestore();
      releaseSpy.mockRestore();
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

  it('runs execute exits 1 with friendly message when lease acquisition fails', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-exec-leaseconflict-')));
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
    const runUuid = 'test-exec-conflict-uuid';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-100-20260622-000000',
      100,
      'issue_to_pr',
      'queued',
      '[]',
      new Date().toISOString(),
    );
    db.close();

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
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['execute', '--uuid', runUuid], { from: 'user' });
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

  it('runs execute aborts after consecutive heartbeat failures', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-exec-hbfail-')));
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
    const runUuid = 'test-exec-hb-fail-uuid';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-99-20260622-000000',
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
      const acquireSpy = vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-${process.pid}`),
        runId: runUuid as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 100),
      });
      const heartbeatSpy = vi
        .spyOn(WorkerLeaseRepository.prototype, 'heartbeat')
        .mockImplementation(() => {
          throw new Error('db unavailable');
        });
      const releaseSpy = vi
        .spyOn(WorkerLeaseRepository.prototype, 'release')
        .mockReturnValue(undefined);
      const executeSpy = vi
        .spyOn(RunExecutor.prototype, 'execute')
        .mockReturnValue(new Promise(() => {}));
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({
        composeOverrides: { repoFullName: 'owner/repo' },
        lease: { ttlMs: 100, heartbeatIntervalMs: 20 },
      });

      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      runsCmd.parseAsync(['execute', '--uuid', runUuid], { from: 'user' }).catch(() => {});

      // maxHeartbeatFailures = ceil(100/20) - 1 = 4. Wait for 5 intervals.
      await new Promise((r) => setTimeout(r, 500));

      expect(exitSpy).toHaveBeenCalledWith(2);
      expect(releaseSpy).toHaveBeenCalledOnce();

      acquireSpy.mockRestore();
      heartbeatSpy.mockRestore();
      releaseSpy.mockRestore();
      executeSpy.mockRestore();
      exitSpy.mockRestore();
      writeSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });
});

describe('CLI run command signal handlers', () => {
  it('marks run as cancelled when process receives SIGTERM', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-sigterm-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/opsclawd/automation.git'], {
      cwd: root,
    });
    writeFileSync(join(root, 'README.md'), 'orchestrator test repo');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-q', '--author=Test <test@test.com>', '-m', 'init'], {
      cwd: root,
    });
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
    const scriptPath = join(root, 'long-running.sh');
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nsleep 60\n');
    chmodSync(scriptPath, 0o755);

    const child = spawnOrchestrator(
      ['run', '--issue', '77', '--executor', 'ts', '--script', scriptPath],
      root,
    );

    const stderr: string[] = [];
    child.stderr?.on('data', (d) => stderr.push(d.toString()));

    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');

    // Wait for the run row to appear (up to 15s)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for run row')), 15_000);
      const poll = () => {
        try {
          const db = openDatabase(dbPath);
          const row = db
            .prepare(
              `SELECT runs.uuid, worker_leases.repo_id
               FROM runs
               JOIN worker_leases ON worker_leases.run_id = runs.uuid
               WHERE runs.issue_number = 77`,
            )
            .get();
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
    const lease = db.prepare('SELECT repo_id FROM worker_leases').get();
    expect(lease).toBeUndefined();
    db.close();

    expect(run.status).toBe('cancelled');
    expect(run.failure_reason).toMatch(/interrupted by SIGTERM/i);
  }, 45_000);

  it('marks run as cancelled when process receives SIGINT', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-sigint-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/opsclawd/automation.git'], {
      cwd: root,
    });
    writeFileSync(join(root, 'README.md'), 'orchestrator test repo');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-q', '--author=Test <test@test.com>', '-m', 'init'], {
      cwd: root,
    });
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
    const scriptPath = join(root, 'long-running.sh');
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nsleep 60\n');
    chmodSync(scriptPath, 0o755);

    const child = spawnOrchestrator(
      ['run', '--issue', '78', '--executor', 'ts', '--script', scriptPath],
      root,
    );

    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for run row')), 15_000);
      const poll = () => {
        try {
          const db = openDatabase(dbPath);
          const row = db
            .prepare(
              `SELECT runs.uuid, worker_leases.repo_id
               FROM runs
               JOIN worker_leases ON worker_leases.run_id = runs.uuid
               WHERE runs.issue_number = 78`,
            )
            .get();
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
    const lease = db.prepare('SELECT repo_id FROM worker_leases').get();
    expect(lease).toBeUndefined();
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
      const createWorktreeSpy = vi
        .spyOn(GitWorktreeAdapter.prototype, 'createWorktree')
        .mockResolvedValue(undefined);
      const headCommitShaSpy = vi
        .spyOn(GitWorktreeAdapter.prototype, 'headCommitSha')
        .mockResolvedValue('abc123def456abc123def456abc123def456abc123');
      const removeWorktreeSpy = vi
        .spyOn(GitWorktreeAdapter.prototype, 'removeWorktree')
        .mockResolvedValue(undefined);

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
      // Released BEFORE process.exit — not via a finally block, which the real
      // process.exit() bypasses (regression guard: relying on finally leaks the
      // lease in production, locking the repo after one run).
      expect(releaseSpy.mock.invocationCallOrder[0]!).toBeLessThan(
        exitSpy.mock.invocationCallOrder[0]!,
      );
      expect(insertSpy).toHaveBeenCalledOnce();
      expect(insertSpy.mock.calls[0][0]).toMatchObject({
        issueNumber: 57,
        displayId: expect.any(String),
      });
      // Worktree was created before execute
      expect(createWorktreeSpy).toHaveBeenCalledOnce();
      expect(createWorktreeSpy.mock.calls[0][0]).toMatchObject({
        branch: 'ai/issue-57',
      });
      // removeWorktree called once because run passed
      expect(removeWorktreeSpy).toHaveBeenCalledOnce();

      acquireSpy.mockRestore();
      heartbeatSpy.mockRestore();
      releaseSpy.mockRestore();
      executeSpy.mockRestore();
      insertSpy.mockRestore();
      createWorktreeSpy.mockRestore();
      headCommitShaSpy.mockRestore();
      removeWorktreeSpy.mockRestore();
      writeSpy.mockRestore();
      exitSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('does not overwrite a non-passed terminal status with failed when stdout write rejects', async () => {
    // Regression for PR #458 threads r3456905472 / r3456964886: execute() persists
    // its terminal status (here 'blocked'); if process.stdout.write then rejects
    // (EPIPE), the catch must NOT clobber it with 'failed'. The fix uses a
    // conditional atomicUpdateByUuid(..., 'running') instead of unconditional update().
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-term-')));
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
      vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-pid-${process.pid}`),
        runId: 'mock-run-uuid' as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 120_000),
      });
      vi.spyOn(WorkerLeaseRepository.prototype, 'heartbeat').mockReturnValue(undefined);
      vi.spyOn(WorkerLeaseRepository.prototype, 'release').mockReturnValue(undefined);
      vi.spyOn(GitWorktreeAdapter.prototype, 'createWorktree').mockResolvedValue(undefined);
      vi.spyOn(GitWorktreeAdapter.prototype, 'headCommitSha').mockResolvedValue(
        'abc123def456abc123def456abc123def456abc123',
      );
      vi.spyOn(GitWorktreeAdapter.prototype, 'removeWorktree').mockResolvedValue(undefined);
      vi.spyOn(RunRepository.prototype, 'insertIfNoActive').mockReturnValue(undefined);

      // execute() returns a terminal 'blocked' status (already persisted by execute)
      vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: {
          uuid: 'mock-run-uuid',
          status: 'blocked' as const,
          displayId: 'issue-58-20260622-000000',
          issueNumber: 58,
          type: 'issue_to_pr',
          completedPhases: [],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [],
      });

      const atomicSpy = vi
        .spyOn(RunRepository.prototype, 'atomicUpdateByUuid')
        .mockReturnValue(false); // no-op: run is 'blocked', not 'running'
      const updateSpy = vi.spyOn(RunRepository.prototype, 'update').mockReturnValue(undefined);

      // stdout.write REJECTS (EPIPE) → drives the catch block
      vi.spyOn(process.stdout, 'write').mockImplementation(((
        _chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(new Error('EPIPE'));
        return false;
      }) as never);
      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '58',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);

      // The catch must use the guarded conditional update (expectedStatus 'running'),
      // which is a no-op on the 'blocked' run — never the unconditional update().
      expect(atomicSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ status: 'failed' }),
        'running',
      );
      expect(updateSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 'failed' }),
      );

      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('releases lease when insertIfNoActive throws', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-insertfail-')));
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
        workerId: WorkerId(`cli-${process.pid}`),
        runId: 'mock-run-uuid' as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 120_000),
      });
      const releaseSpy = vi
        .spyOn(WorkerLeaseRepository.prototype, 'release')
        .mockReturnValue(undefined);
      const insertSpy = vi
        .spyOn(RunRepository.prototype, 'insertIfNoActive')
        .mockImplementation(() => {
          throw new Error('duplicate run');
        });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '58',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);

      expect(releaseSpy).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(2);

      acquireSpy.mockRestore();
      releaseSpy.mockRestore();
      insertSpy.mockRestore();
      exitSpy.mockRestore();
      writeSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('aborts run after consecutive heartbeat failures', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-hbfail-')));
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
        workerId: WorkerId(`cli-${process.pid}`),
        runId: 'mock-run-uuid' as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 100),
      });
      const heartbeatSpy = vi
        .spyOn(WorkerLeaseRepository.prototype, 'heartbeat')
        .mockImplementation(() => {
          throw new Error('db unavailable');
        });
      const releaseSpy = vi
        .spyOn(WorkerLeaseRepository.prototype, 'release')
        .mockReturnValue(undefined);
      const executeSpy = vi
        .spyOn(RunExecutor.prototype, 'execute')
        .mockReturnValue(new Promise(() => {}));
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({
        composeOverrides: { repoFullName: 'owner/repo' },
        lease: { ttlMs: 100, heartbeatIntervalMs: 20 },
      });

      program
        .parseAsync([
          'node',
          'orchestrator',
          'run',
          '--issue',
          '59',
          '--executor',
          'ts',
          '--script',
          '/dev/null',
        ])
        .catch(() => {});

      // maxHeartbeatFailures = ceil(100/20) - 1 = 4. Wait for 5 intervals.
      await new Promise((r) => setTimeout(r, 500));

      expect(exitSpy).toHaveBeenCalledWith(2);
      // release count is timing-dependent (heartbeat abort may or may not
      // precede the worktree error catch block). At least 1 means released.
      expect(releaseSpy).toHaveBeenCalled();

      acquireSpy.mockRestore();
      heartbeatSpy.mockRestore();
      releaseSpy.mockRestore();
      executeSpy.mockRestore();
      writeSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('releases lease when execute throws', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-execfail-')));
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
        workerId: WorkerId(`cli-${process.pid}`),
        runId: 'mock-run-uuid' as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 120_000),
      });
      const releaseSpy = vi
        .spyOn(WorkerLeaseRepository.prototype, 'release')
        .mockReturnValue(undefined);
      const executeSpy = vi
        .spyOn(RunExecutor.prototype, 'execute')
        .mockRejectedValue(new Error('execution error'));
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '60',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);

      expect(releaseSpy).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(2);

      acquireSpy.mockRestore();
      releaseSpy.mockRestore();
      executeSpy.mockRestore();
      exitSpy.mockRestore();
      writeSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('creates worktree before execute and captures startCommitSha on the run record', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-worktree-')));
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
      const callOrder: string[] = [];

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
      const createWorktreeSpy = vi
        .spyOn(GitWorktreeAdapter.prototype, 'createWorktree')
        .mockImplementation(async () => {
          callOrder.push('createWorktree');
        });
      const headCommitShaSpy = vi
        .spyOn(GitWorktreeAdapter.prototype, 'headCommitSha')
        .mockResolvedValue('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      const removeWorktreeSpy = vi
        .spyOn(GitWorktreeAdapter.prototype, 'removeWorktree')
        .mockResolvedValue(undefined);
      const updateSpy = vi.spyOn(RunRepository.prototype, 'update');
      const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockImplementation(async () => {
        callOrder.push('execute');
        return {
          run: {
            uuid: 'mock-run-uuid',
            status: 'passed' as const,
            displayId: 'issue-61-20260622-000000',
            issueNumber: 61,
            type: 'issue_to_pr' as const,
            completedPhases: ['read-issue'],
            skippedPhases: [],
            startedAt: new Date(),
          },
          phases: [{ phase: 'read-issue', status: 'passed' }],
        };
      });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '61',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);

      // createWorktree must happen before execute
      expect(callOrder).toEqual(['createWorktree', 'execute']);
      // branch name must be ai/issue-<N>
      expect(createWorktreeSpy.mock.calls[0][0]).toMatchObject({ branch: 'ai/issue-61' });
      // startCommitSha must be set on the run record via update()
      const updateCalls = updateSpy.mock.calls;
      const shaUpdate = updateCalls.find(
        (c) => c[1] && (c[1] as Record<string, unknown>).startCommitSha,
      );
      expect(shaUpdate).toBeDefined();
      expect((shaUpdate![1] as Record<string, unknown>).startCommitSha).toBe(
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      );
      // worktree removed because run passed
      expect(removeWorktreeSpy).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(0);

      acquireSpy.mockRestore();
      heartbeatSpy.mockRestore();
      releaseSpy.mockRestore();
      createWorktreeSpy.mockRestore();
      headCommitShaSpy.mockRestore();
      removeWorktreeSpy.mockRestore();
      updateSpy.mockRestore();
      executeSpy.mockRestore();
      exitSpy.mockRestore();
      writeSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('does not remove the worktree when the run fails', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-noremove-')));
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
      const createWorktreeSpy = vi
        .spyOn(GitWorktreeAdapter.prototype, 'createWorktree')
        .mockResolvedValue(undefined);
      const headCommitShaSpy = vi
        .spyOn(GitWorktreeAdapter.prototype, 'headCommitSha')
        .mockResolvedValue('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
      const removeWorktreeSpy = vi
        .spyOn(GitWorktreeAdapter.prototype, 'removeWorktree')
        .mockResolvedValue(undefined);
      const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: {
          uuid: 'mock-run-uuid',
          status: 'failed' as const,
          displayId: 'issue-62-20260622-000000',
          issueNumber: 62,
          type: 'issue_to_pr' as const,
          completedPhases: [],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [],
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '62',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);

      expect(createWorktreeSpy).toHaveBeenCalledOnce();
      // worktree must NOT be removed when run fails
      expect(removeWorktreeSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);

      acquireSpy.mockRestore();
      heartbeatSpy.mockRestore();
      releaseSpy.mockRestore();
      createWorktreeSpy.mockRestore();
      headCommitShaSpy.mockRestore();
      removeWorktreeSpy.mockRestore();
      executeSpy.mockRestore();
      exitSpy.mockRestore();
      writeSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('streams progress to stderr when --verbose is passed', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-verbose-')));
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
      const subscribeSpy = vi.spyOn(InMemoryEventBus.prototype, 'subscribe');
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-pid-${process.pid}`),
        runId: 'mock-run-uuid' as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 120_000),
      });
      vi.spyOn(WorkerLeaseRepository.prototype, 'heartbeat').mockReturnValue(undefined);
      vi.spyOn(WorkerLeaseRepository.prototype, 'release').mockReturnValue(undefined);
      vi.spyOn(GitWorktreeAdapter.prototype, 'createWorktree').mockResolvedValue(undefined);
      vi.spyOn(GitWorktreeAdapter.prototype, 'headCommitSha').mockResolvedValue(
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      );
      vi.spyOn(GitWorktreeAdapter.prototype, 'removeWorktree').mockResolvedValue(undefined);
      vi.spyOn(RunRepository.prototype, 'insertIfNoActive').mockReturnValue(undefined);

      vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: {
          uuid: 'mock-run-uuid',
          status: 'passed' as const,
          displayId: 'issue-70-20260622-000000',
          issueNumber: 70,
          type: 'issue_to_pr' as const,
          completedPhases: ['read-issue'],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [{ phase: 'read-issue', status: 'passed' }],
      });

      vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);
      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '70',
        '--executor',
        'ts',
        '--verbose',
        '--script',
        '/dev/null',
      ]);

      // subscribe must be called to set up the event bus listener
      expect(subscribeSpy).toHaveBeenCalled();

      // Verify the captured listener actually writes [ts]-prefixed messages to console.error
      const listener = subscribeSpy.mock.calls[0]?.[1];
      expect(listener).toBeDefined();
      listener?.({
        runId: 'mock-run-uuid',
        type: 'phase.started',
        level: 'info' as const,
        message: 'starting phase read_issue',
        timestamp: new Date().toISOString(),
        metadata: {},
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ts] starting phase read_issue'),
      );

      subscribeSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('does not stream progress when --no-verbose is passed', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-noverbose-')));
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
      const subscribeSpy = vi.spyOn(InMemoryEventBus.prototype, 'subscribe');

      vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-pid-${process.pid}`),
        runId: 'mock-run-uuid' as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 120_000),
      });
      vi.spyOn(WorkerLeaseRepository.prototype, 'heartbeat').mockReturnValue(undefined);
      vi.spyOn(WorkerLeaseRepository.prototype, 'release').mockReturnValue(undefined);
      vi.spyOn(GitWorktreeAdapter.prototype, 'createWorktree').mockResolvedValue(undefined);
      vi.spyOn(GitWorktreeAdapter.prototype, 'headCommitSha').mockResolvedValue(
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      );
      vi.spyOn(GitWorktreeAdapter.prototype, 'removeWorktree').mockResolvedValue(undefined);
      vi.spyOn(RunRepository.prototype, 'insertIfNoActive').mockReturnValue(undefined);
      vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: {
          uuid: 'mock-run-uuid',
          status: 'passed' as const,
          displayId: 'issue-71-20260622-000000',
          issueNumber: 71,
          type: 'issue_to_pr' as const,
          completedPhases: [],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [],
      });
      vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);
      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '71',
        '--executor',
        'ts',
        '--no-verbose',
        '--script',
        '/dev/null',
      ]);

      // subscribe must NOT be called when --no-verbose suppresses output
      expect(subscribeSpy).not.toHaveBeenCalled();

      subscribeSpy.mockRestore();
      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('outputs final JSON to stdout when --verbose is active', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-verbose-json-')));
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
      vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-pid-${process.pid}`),
        runId: 'mock-run-uuid' as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 120_000),
      });
      vi.spyOn(WorkerLeaseRepository.prototype, 'heartbeat').mockReturnValue(undefined);
      vi.spyOn(WorkerLeaseRepository.prototype, 'release').mockReturnValue(undefined);
      vi.spyOn(GitWorktreeAdapter.prototype, 'createWorktree').mockResolvedValue(undefined);
      vi.spyOn(GitWorktreeAdapter.prototype, 'headCommitSha').mockResolvedValue(
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      );
      vi.spyOn(GitWorktreeAdapter.prototype, 'removeWorktree').mockResolvedValue(undefined);
      vi.spyOn(RunRepository.prototype, 'insertIfNoActive').mockReturnValue(undefined);
      vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: {
          uuid: 'mock-run-uuid',
          status: 'passed' as const,
          displayId: 'issue-72-20260622-000000',
          issueNumber: 72,
          type: 'issue_to_pr' as const,
          completedPhases: ['read-issue'],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [{ phase: 'read-issue', status: 'passed' }],
      });

      const stdoutChunks: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);
      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '72',
        '--executor',
        'ts',
        '--verbose',
        '--script',
        '/dev/null',
      ]);

      const output = JSON.parse(stdoutChunks.join(''));
      expect(output).toHaveProperty('run');
      expect(output.run.uuid).toBe('mock-run-uuid');
      expect(output.run.status).toBe('passed');
      expect(output).toHaveProperty('phases');

      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });
});

describe('CLI runs resume command', () => {
  it('exits 1 when --uuid is missing', async () => {
    const program = buildProgram();
    const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
    const resumeCmd = runsCmd.commands.find((c) => c.name() === 'resume')!;
    resumeCmd.exitOverride();
    const errs: string[] = [];
    resumeCmd.configureOutput({ writeErr: (s) => void errs.push(s), writeOut: () => {} });
    await expect(runsCmd.parseAsync(['resume'], { from: 'user' })).rejects.toMatchObject({
      exitCode: 1,
    });
    expect(errs.join('')).toMatch(/--uuid/i);
  });

  it('exits 1 when RunExecutor is not available', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-resume-noexec-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const consoleErrs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram();
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['resume', '--uuid', 'any-uuid'], { from: 'user' });
      const exitCode = exitSpy.mock.calls[0]?.[0];
      errSpy.mockRestore();
      exitSpy.mockRestore();
      expect(exitCode).toBe(1);
      expect(consoleErrs.join('')).toMatch(/RunExecutor not available/i);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('exits 1 when run not found', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-resume-nf-')));
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
      await runsCmd.parseAsync(['resume', '--uuid', 'nonexistent-uuid'], { from: 'user' });
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

  it('calls retryFailedPhase when --from-phase is not provided', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-resume-nofp-')));
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
    const runUuid = 'resume-nofp-uuid';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-110-20260622-000000',
      110,
      'issue_to_pr',
      'failed',
      '[]',
      new Date().toISOString(),
    );
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const retrySpy = vi.spyOn(RetryFailedPhase.prototype, 'execute').mockResolvedValue(undefined);
      const transitionSpy = vi.spyOn(ResumeRun.prototype, 'transition').mockResolvedValue({
        savedCompletedAt: null,
        savedFailureReason: null,
        savedCurrentPhase: null,
        savedCompletedPhases: [],
        savedSkippedPhases: [],
        savedSteps: [],
      });
      const acquireSpy = vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-${process.pid}`),
        runId: runUuid as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
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
          uuid: runUuid,
          status: 'passed' as const,
          displayId: '',
          issueNumber: 110,
          type: 'issue_to_pr' as const,
          completedPhases: [],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [],
      });
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['resume', '--uuid', runUuid], { from: 'user' });

      expect(retrySpy).toHaveBeenCalledWith(
        expect.objectContaining({ runId: expect.any(String), workerId: expect.any(String) }),
      );
      expect(transitionSpy).not.toHaveBeenCalled();

      retrySpy.mockRestore();
      transitionSpy.mockRestore();
      acquireSpy.mockRestore();
      heartbeatSpy.mockRestore();
      releaseSpy.mockRestore();
      executeSpy.mockRestore();
      writeSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('calls resumeRun when --from-phase is provided', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-resume-fp-')));
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
    const runUuid = 'resume-fp-uuid';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-111-20260622-000000',
      111,
      'issue_to_pr',
      'failed',
      '[]',
      new Date().toISOString(),
    );
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const transitionSpy = vi.spyOn(ResumeRun.prototype, 'transition').mockResolvedValue({
        savedCompletedAt: null,
        savedFailureReason: null,
        savedCurrentPhase: null,
        savedCompletedPhases: [],
        savedSkippedPhases: [],
        savedSteps: [],
      });
      const acquireSpy = vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-${process.pid}`),
        runId: runUuid as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
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
          uuid: runUuid,
          status: 'passed' as const,
          displayId: '',
          issueNumber: 111,
          type: 'issue_to_pr' as const,
          completedPhases: [],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [],
      });
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['resume', '--uuid', runUuid, '--from-phase', 'implement'], {
        from: 'user',
      });

      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: expect.any(String),
          fromPhase: 'implement',
          workerId: expect.any(String),
        }),
      );

      transitionSpy.mockRestore();
      acquireSpy.mockRestore();
      heartbeatSpy.mockRestore();
      releaseSpy.mockRestore();
      executeSpy.mockRestore();
      writeSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('writes JSON output on successful execution', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-resume-json-')));
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
    const runUuid = 'resume-json-uuid';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-112-20260622-000000',
      112,
      'issue_to_pr',
      'failed',
      '[]',
      new Date().toISOString(),
    );
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const retrySpy = vi.spyOn(RetryFailedPhase.prototype, 'execute').mockResolvedValue(undefined);
      const acquireSpy = vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-${process.pid}`),
        runId: runUuid as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
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
          uuid: runUuid,
          status: 'passed' as const,
          displayId: '',
          issueNumber: 112,
          type: 'issue_to_pr' as const,
          completedPhases: [],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [{ phase: 'implement', status: 'passed' }],
      });
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

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['resume', '--uuid', runUuid], { from: 'user' });

      const output = JSON.parse(stdoutChunks.join(''));
      expect(output).toHaveProperty('run');
      expect(output.run.uuid).toBe(runUuid);
      expect(output.run.status).toBe('passed');
      expect(output).toHaveProperty('phases');
      expect(output.phases).toHaveLength(1);

      retrySpy.mockRestore();
      acquireSpy.mockRestore();
      heartbeatSpy.mockRestore();
      releaseSpy.mockRestore();
      executeSpy.mockRestore();
      writeSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('exits 1 when repoFullName is missing', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-resume-norepo-')));
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
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'resume-norepo-uuid',
      'issue-101-20260622-000000',
      101,
      'issue_to_pr',
      'failed',
      '[]',
      new Date().toISOString(),
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
      await runsCmd.parseAsync(['resume', '--uuid', 'resume-norepo-uuid'], { from: 'user' });
      const capturedConsole = consoleErrs.join('');
      const exitCode = exitSpy.mock.calls[0]?.[0];
      spy.mockRestore();
      exitSpy.mockRestore();
      expect(exitCode).toBe(1);
      expect(capturedConsole).toMatch(/could not determine repository name/i);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('does not transition a run when lease acquisition fails', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-resume-lease-conflict-')));
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
    const runUuid = 'resume-lease-conflict-uuid';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-131-20260625-000000',
      131,
      'issue_to_pr',
      'failed',
      '[]',
      new Date().toISOString(),
    );
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const transitionSpy = vi.spyOn(ResumeRun.prototype, 'transition');
      const retrySpy = vi.spyOn(RetryFailedPhase.prototype, 'execute');
      const acquireSpy = vi
        .spyOn(WorkerLeaseRepository.prototype, 'acquire')
        .mockImplementation(() => {
          throw new WorkerLeaseConflictError(RepositoryId('owner/repo'), WorkerId('other-worker'));
        });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called');
      }) as never);
      const consoleErrs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await expect(
        runsCmd.parseAsync(['resume', '--uuid', runUuid], { from: 'user' }),
      ).rejects.toThrow(/process\.exit called/i);

      expect(acquireSpy).toHaveBeenCalled();
      expect(transitionSpy).not.toHaveBeenCalled();
      expect(retrySpy).not.toHaveBeenCalled();
      expect(consoleErrs.join('')).toMatch(/already has an active lease/i);
      const db2 = openDatabase(dbPath);
      const row = db2.prepare('SELECT status FROM runs WHERE uuid = ?').get(runUuid) as {
        status: string;
      };
      db2.close();
      expect(row.status).toBe('failed');

      transitionSpy.mockRestore();
      retrySpy.mockRestore();
      acquireSpy.mockRestore();
      exitSpy.mockRestore();
      errSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('transitions run from failed status and writes JSON via real retry use case', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-resume-transition-')));
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
    const runUuid = 'resume-transition-uuid';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, skipped_phases, started_at, current_phase)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-130-20260625-000000',
      130,
      'issue_to_pr',
      'failed',
      '[]',
      '[]',
      new Date().toISOString(),
      'implement',
    );
    db.prepare(
      `INSERT INTO phases (id, run_uuid, name, status, attempt, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('phase-130-implement', runUuid, 'implement', 'failed', 1, new Date().toISOString());
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const transitionSpy = vi.spyOn(ResumeRun.prototype, 'transition');
      // Do NOT mock RetryFailedPhase — the real use case must actually
      // transition the run from 'failed' via the ResumeRun CAS.
      const acquireSpy = vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-${process.pid}`),
        runId: runUuid as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
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
          uuid: runUuid,
          status: 'passed' as const,
          displayId: '',
          issueNumber: 130,
          type: 'issue_to_pr' as const,
          completedPhases: [],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [{ phase: 'implement', status: 'passed' }],
      });
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
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['resume', '--uuid', runUuid], { from: 'user' });

      // Verify JSON was written (same as other resume tests)
      const output = JSON.parse(stdoutChunks.join(''));
      expect(output).toHaveProperty('run');
      expect(output.run.uuid).toBe(runUuid);
      expect(output).toHaveProperty('phases');

      // Verify the run was actually transitioned from 'failed' by the real
      // RetryFailedPhase → ResumeRun CAS (no error exit)
      const db2 = openDatabase(dbPath);
      const row = db2.prepare('SELECT status FROM runs WHERE uuid = ?').get(runUuid) as {
        status: string;
      };
      db2.close();
      expect(transitionSpy).toHaveBeenCalled();
      expect(row.status).not.toBe('failed');
      expect(exitSpy).not.toHaveBeenCalled();

      transitionSpy.mockRestore();
      acquireSpy.mockRestore();
      heartbeatSpy.mockRestore();
      releaseSpy.mockRestore();
      executeSpy.mockRestore();
      writeSpy.mockRestore();
      exitSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });
});
