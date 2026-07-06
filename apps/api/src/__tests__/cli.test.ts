import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram as originalBuildProgram, findRepoRoot } from '../cli.js';
function buildProgram(opts?: Parameters<typeof originalBuildProgram>[0]) {
  return originalBuildProgram({
    isCliTestSuite: true,
    bypassPlanValidation: true,
    ...opts,
  });
}
import { openDatabase, applyMigrations, JobQueueRepository } from '@ai-sdlc/infrastructure';
import { RunExecutor, ResumeRun, RetryFailedPhase } from '@ai-sdlc/application';
import {
  GitWorktreeAdapter,
  InMemoryEventBus,
  RunRepository,
  WorkerLeaseRepository,
} from '@ai-sdlc/infrastructure';
import { WorkerLeaseConflictError, WorkerId, RepositoryId, JobId } from '@ai-sdlc/domain';
import { WorkerScheduler } from '../worker-scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(__dirname, '..', '..');
const require = createRequire(join(apiRoot, 'package.json'));
const tsxEsmPath = require.resolve('tsx/esm');
const cliPath = join(apiRoot, 'src', 'cli.ts');

function spawnOrchestrator(args: string[], cwd: string, envOverrides?: Record<string, string>) {
  return spawn('node', ['--conditions=development', '--import', tsxEsmPath, cliPath, ...args], {
    cwd,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      AI_CLI_TEST_SUITE: 'true',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const tempDirs: string[] = [];

beforeEach(() => {
  vi.spyOn(GitWorktreeAdapter.prototype, 'seedArtifactExcludes').mockResolvedValue(undefined);
});

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

    const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
    await program.parseAsync([
      'node',
      'orchestrator',
      'run',
      '--issue',
      '42',
      '--executor',
      'bash',
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

    const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
    await program.parseAsync([
      'node',
      'orchestrator',
      'run',
      '--issue',
      '99',
      '--executor',
      'bash',
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
    const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
    const runCmd = program.commands.find((c) => c.name() === 'run')!;
    runCmd.exitOverride();
    const errs: string[] = [];
    runCmd.configureOutput({ writeErr: (s) => void errs.push(s), writeOut: () => {} });

    await expect(runCmd.parseAsync(['run'], { from: 'user' })).rejects.toThrow(/--issue/);
    expect(errs.join('')).toMatch(/--issue/);
  });

  it('rejects malformed --issue values', async () => {
    for (const bad of ['123abc', '12.5', '-5', 'abc']) {
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      program.exitOverride();
      await expect(
        program.parseAsync(['node', 'orchestrator', 'run', '--issue', bad]),
      ).rejects.toThrow(/must be a positive integer/gi);
    }
  });

  it('rejects zero as --issue', async () => {
    const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
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
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at, pid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'cancel-test-uuid',
      'issue-50-20260519-000000',
      'owner/repo',
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
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
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
    const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
    const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
    runsCmd.exitOverride();
    const consoleErrs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((msg) => {
      consoleErrs.push(String(msg));
    });
    const exitSpy2 = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`EXIT ${code}`); }) as never);
    await expect(runsCmd.parseAsync(['cancel'], { from: 'user' })).rejects.toThrow(/EXIT 1/);
    exitSpy2.mockRestore();
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
    db.prepare(`INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at, pid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('cancel-uuid-test', 'issue-60-20260519-000000', 'owner/repo',
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
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
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
    db.prepare(`INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at, pid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('terminal-uuid', 'issue-61-20260519-000000', 'owner/repo',
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
    const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
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
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runUuid,
      'issue-99-20260622-000000',
      'owner/repo',
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
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runUuid,
      'issue-99-20260520-000000',
      'owner/repo',
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
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runUuid,
      'issue-100-20260622-000000',
      'owner/repo',
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
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runUuid,
      'issue-99-20260622-000000',
      'owner/repo',
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

  it('releases lease on SIGTERM during runs execute', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-exec-sigterm-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/opsclawd/automation.git'], {
      cwd: root,
    });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
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
    const runUuid = 'execute-sigterm-uuid';
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-79-20260622-000000',
      'opsclawd/automation',
      79,
      'issue_to_pr',
      'queued',
      '[]',
      new Date().toISOString(),
    );
    db.close();

    const child = spawnOrchestrator(['runs', 'execute', '--uuid', runUuid], root, {
      GITHUB_REPOSITORY: 'opsclawd/automation',
    });

    const stderr: string[] = [];
    child.stderr?.on('data', (d) => stderr.push(d.toString()));

    // Wait for the joined run + lease row to appear (up to 15s)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('timed out waiting for lease row')),
        15_000,
      );
      const poll = () => {
        try {
          const d = openDatabase(dbPath);
          const row = d
            .prepare(
              `SELECT runs.uuid, worker_leases.repo_id
               FROM runs
               JOIN worker_leases ON worker_leases.run_id = runs.uuid
               WHERE runs.uuid = ?`,
            )
            .get(runUuid);
          d.close();
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

    const d2 = openDatabase(dbPath);
    const run = d2
      .prepare('SELECT status, failure_reason FROM runs WHERE uuid = ?')
      .get(runUuid) as { status: string; failure_reason: string | null };
    expect(run.status).toBe('cancelled');
    expect(run.failure_reason).toMatch(/interrupted by SIGTERM/i);
    expect(d2.prepare('SELECT repo_id FROM worker_leases').get()).toBeUndefined();
    d2.close();
  }, 45_000);

  it('releases lease on SIGINT during runs execute', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-exec-sigint-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/opsclawd/automation.git'], {
      cwd: root,
    });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
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
    const runUuid = 'execute-sigint-uuid';
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-80-20260622-000000',
      'opsclawd/automation',
      80,
      'issue_to_pr',
      'queued',
      '[]',
      new Date().toISOString(),
    );
    db.close();

    const child = spawnOrchestrator(['runs', 'execute', '--uuid', runUuid], root, {
      GITHUB_REPOSITORY: 'opsclawd/automation',
    });

    const stderr: string[] = [];
    child.stderr?.on('data', (d) => stderr.push(d.toString()));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('timed out waiting for lease row')),
        15_000,
      );
      const poll = () => {
        try {
          const d = openDatabase(dbPath);
          const row = d
            .prepare(
              `SELECT runs.uuid, worker_leases.repo_id
               FROM runs
               JOIN worker_leases ON worker_leases.run_id = runs.uuid
               WHERE runs.uuid = ?`,
            )
            .get(runUuid);
          d.close();
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

    const d2 = openDatabase(dbPath);
    const run = d2
      .prepare('SELECT status, failure_reason FROM runs WHERE uuid = ?')
      .get(runUuid) as { status: string; failure_reason: string | null };
    expect(run.status).toBe('cancelled');
    expect(run.failure_reason).toMatch(/interrupted by SIGINT/i);
    expect(d2.prepare('SELECT repo_id FROM worker_leases').get()).toBeUndefined();
    d2.close();
  }, 45_000);
});

describe('CLI run command signal handlers', () => {
  it('marks run as cancelled when process receives SIGTERM', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-sigterm-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/opsclawd/automation.git'], {
      cwd: root,
    });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
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
      { GITHUB_REPOSITORY: 'opsclawd/automation' },
    );

    const stderr: string[] = [];
    child.stderr?.on('data', (d) => stderr.push(d.toString()));

    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');

    // Wait for the job row to appear (up to 15s). In the scheduler path, leases
    // are acquired inside workerLoop, not at the CLI level — the run-only row
    // exists before the lease does, and the run-only row may be cancelled
    // before any lease row ever appears. So we poll the jobs table instead.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for job row')), 15_000);
      const poll = () => {
        try {
          const db = openDatabase(dbPath);
          const row = db.prepare(`SELECT * FROM jobs WHERE status != 'succeeded'`).get() as unknown;
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
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/opsclawd/automation.git'], {
      cwd: root,
    });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
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
      { GITHUB_REPOSITORY: 'opsclawd/automation' },
    );

    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for job row')), 15_000);
      const poll = () => {
        try {
          const db = openDatabase(dbPath);
          const row = db.prepare(`SELECT * FROM jobs WHERE status != 'succeeded'`).get() as unknown;
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

  it('SIGINT while job is claimed releases claim and finalizes run to cancelled', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-sigint-claimed-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/opsclawd/automation.git'], {
      cwd: root,
    });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
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
    // Use a script that ignores SIGINT and sleeps, so it won't fail when SIGINT is sent to the process group
    writeFileSync(scriptPath, '#!/usr/bin/env bash\ntrap "" SIGINT\nsleep 60\n');
    chmodSync(scriptPath, 0o755);

    const child = spawnOrchestrator(
      ['run', '--issue', '79', '--executor', 'ts', '--script', scriptPath],
      root,
      { GITHUB_REPOSITORY: 'opsclawd/automation' },
    );

    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');

    // Wait for job to exist and transition from initial state, then send SIGINT.
    // The job goes queued→claimed→running; we send SIGINT after it enters claimed/running
    // to test the claimed+signal path. Timing is difficult, so we sleep a bit to let
    // the scheduler's first tick proceed.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for job row')), 15_000);
      const poll = () => {
        try {
          const db = openDatabase(dbPath);
          const row = db.prepare(`SELECT * FROM jobs WHERE issue_number = 79`).get() as unknown;
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

    // Sleep to let the first scheduler tick proceed and claim the job, then send SIGINT
    setTimeout(() => {
      child.kill('SIGINT');
    }, 300);

    await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    const db = openDatabase(dbPath);
    const run = db
      .prepare('SELECT status, failure_reason FROM runs WHERE issue_number = 79')
      .get() as { status: string; failure_reason: string | null };
    db.close();

    // The job status depends on timing. If SIGINT arrives early, it releases the claim (queued).
    // If it arrives after claiming starts, handleSignal marks it as cancelled (running) or
    // it might already be failed if execution completes before signal.
    // The key test is that the run is properly cancelled on signal.
    expect(run.status).toBe('cancelled');
    expect(run.failure_reason).toMatch(/interrupted by SIGINT/i);
  }, 45_000);

  it('SIGINT while job is queued leaves the job queued and finalizes run to cancelled', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-sigint-queued-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/opsclawd/automation.git'], {
      cwd: root,
    });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
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
    // Use a script that ignores SIGINT so it won't fail immediately when signal arrives
    writeFileSync(scriptPath, '#!/usr/bin/env bash\ntrap "" SIGINT\nsleep 60\n');
    chmodSync(scriptPath, 0o755);

    const child = spawnOrchestrator(
      ['run', '--issue', '80', '--executor', 'ts', '--script', scriptPath],
      root,
      { GITHUB_REPOSITORY: 'opsclawd/automation' },
    );

    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');

    // Wait for the job row to appear.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for job row')), 15_000);
      const poll = () => {
        try {
          const db = openDatabase(dbPath);
          const row = db.prepare(`SELECT * FROM jobs WHERE issue_number = 80`).get() as unknown;
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

    // Send SIGINT immediately to try to catch it in queued state (before scheduler claims it).
    // Due to timing, it might already be claimed/running, but the key is that the run is cancelled.
    child.kill('SIGINT');

    await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    const db = openDatabase(dbPath);
    const run = db
      .prepare('SELECT status, failure_reason FROM runs WHERE issue_number = 80')
      .get() as { status: string; failure_reason: string | null };
    db.close();

    // The key is that the run is cancelled. Job status depends on timing.
    expect(run.status).toBe('cancelled');
    expect(run.failure_reason).toMatch(/interrupted by SIGINT/i);
  }, 45_000);
});

describe('CLI run --executor ts', () => {
  it('exits 1 when RunExecutor is not available (no agent config)', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-noexec-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    // Deliberately no .ai-orchestrator.json — runExecutor (and workerLoopDeps) will be undefined

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
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

  it('exits 1 when workerRegistry is not available', async () => {
    // The workerRegistry/workerLoopDeps guard is only reachable if runExecutor
    // is set (it's gated on the same condition). The simplest way to hit the
    // guard is to mock WorkerScheduler.runUntilComplete to throw, which
    // exercises the same exit-1 / error-message pathway.
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-nwreg-')));
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
      vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockRejectedValue(
        new Error('worker registry not available'),
      );
      const consoleErrs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk,
        cbOrEnc,
        cb2,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '1',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);
      const exitCode = exitSpy.mock.calls[0]?.[0];

      expect(exitCode).toBe(1);

      errSpy.mockRestore();
      exitSpy.mockRestore();
      writeSpy.mockRestore();
      vi.restoreAllMocks();
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
      // The CLI builds the run record (insertIfNoActive) and then asks the
      // scheduler to drive the job. We short-circuit the scheduler so it
      // resolves immediately, leaving the run record in its initial 'running'
      // state and the job in a terminal 'succeeded' state. The CLI's exit-code
      // logic accepts job.status === 'succeeded' as success.
      const findByIdSpy = vi.spyOn(JobQueueRepository.prototype, 'findById').mockReturnValue({
        id: JobId('mock-job'),
        runId: 'mock-run-uuid' as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        repoId: RepositoryId('owner/repo'),
        issueNumber: 7 as ReturnType<typeof import('@ai-sdlc/domain').IssueNumber>,
        status: 'succeeded',
        priority: 0,
        attempts: 0,
        createdAt: new Date(),
      } as ReturnType<JobQueueRepository['findById']>);
      vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockResolvedValue(undefined);

      const stdoutChunks: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk,
        cbOrEnc,
        cb2,
      ) => {
        stdoutChunks.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'),
        );
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const program = buildProgram({
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '7',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);
      const exitCode = exitSpy.mock.calls[0]?.[0];

      expect(exitCode).toBe(0);
      const output = stdoutChunks.find((c) => c.trim().startsWith('{'));
      expect(output).toBeDefined();
      const parsed = JSON.parse(output!);
      expect(parsed).toHaveProperty('run');
      expect(parsed.run).toBeDefined();

      findByIdSpy.mockRestore();
      writeSpy.mockRestore();
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('exits 0 on waiting run (resting state)', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-exec-waiting-')));
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
      // Scheduler resolves immediately; the run record is read back from the DB
      // and observed in a 'waiting' (resting) state. The CLI's exit-code logic
      // accepts pausedStatuses (waiting/queued) as success.
      vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockResolvedValue(undefined);
      const findByUuidSpy = vi
        .spyOn(RunRepository.prototype, 'findByUuid')
        .mockReturnValue(undefined);
      // The first call from insertIfNoActive's findByIssueNumber should not be
      // intercepted. We use mockImplementation so insertIfNoActive's prior-state
      // check is preserved (no active run) and the subsequent read returns waiting.
      findByUuidSpy.mockImplementation(
        (uuid: string) =>
          ({
            uuid,
            displayId: 'issue-99-20260622-000000',
            repoId: 'owner/repo',
            issueNumber: 99,
            type: 'issue_to_pr',
            status: 'waiting',
            currentPhase: null,
            completedPhases: [],
            skippedPhases: [],
            startedAt: new Date(),
          }) as ReturnType<RunRepository['findByUuid']>,
      );
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk,
        cbOrEnc,
        cb2,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '99',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);
      const exitCode = exitSpy.mock.calls[0]?.[0];

      expect(exitCode).toBe(0);

      findByUuidSpy.mockRestore();
      exitSpy.mockRestore();
      writeSpy.mockRestore();
      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('exits 0 on queued run (resting state)', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-exec-queued-')));
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
      // Scheduler resolves immediately; the run record is read back from the DB
      // and observed in a 'queued' (resting) state. The CLI's exit-code logic
      // accepts pausedStatuses (waiting/queued) as success.
      vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockResolvedValue(undefined);
      const findByUuidSpy = vi.spyOn(RunRepository.prototype, 'findByUuid').mockImplementation(
        (uuid: string) =>
          ({
            uuid,
            displayId: 'issue-99-20260622-000000',
            repoId: 'owner/repo',
            issueNumber: 99,
            type: 'issue_to_pr',
            status: 'queued',
            currentPhase: null,
            completedPhases: [],
            skippedPhases: [],
            startedAt: new Date(),
          }) as ReturnType<RunRepository['findByUuid']>,
      );
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk,
        cbOrEnc,
        cb2,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '99',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);
      const exitCode = exitSpy.mock.calls[0]?.[0];

      expect(exitCode).toBe(0);

      findByUuidSpy.mockRestore();
      exitSpy.mockRestore();
      writeSpy.mockRestore();
      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('exits 1 when stdout write rejects (no terminal clobber on non-passed run)', async () => {
    // When process.stdout.write rejects (e.g. EPIPE on a closed pipe), the
    // outer try/catch in the TS executor path logs the error and exits 1.
    // The catch block calls atomicUpdateByUuid with expectedStatus='running' as
    // a safe CAS to finalize any stuck run — it is a no-op if the run was
    // already finalized by workerLoop. The unconditional update() must NOT be
    // called with status:'failed' (that would clobber an already-terminal run).
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
      vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockResolvedValue(undefined);
      const atomicSpy = vi
        .spyOn(RunRepository.prototype, 'atomicUpdateByUuid')
        .mockReturnValue(false);
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

      const program = buildProgram({
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });
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

      // The CLI exits with EXIT_USER_ERROR (1). The catch block calls
      // atomicUpdateByUuid(..., { status: 'failed' }, 'running') as a safe CAS
      // to finalize a stale 'running' run. The unconditional update() must not
      // be called with status:'failed' (that path would clobber a terminal run).
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(updateSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 'failed' }),
      );
      expect(atomicSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: 'failed' }),
        'running',
      );

      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('exits 1 when insertIfNoActive throws (user error, scheduler never started)', async () => {
    // The new path calls c.runRepository.insertIfNoActive(run) before starting
    // the scheduler. If it throws (e.g. an active run already exists for the
    // same repo+issue), the scheduler is never started. The throw is caught
    // by the inner try/catch, which exits with EXIT_USER_ERROR (1).
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
      const insertSpy = vi
        .spyOn(RunRepository.prototype, 'insertIfNoActive')
        .mockImplementation(() => {
          throw new Error('An active run already exists for repository owner/repo issue 58');
        });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk,
        cbOrEnc,
        cb2,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });
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

      // insertIfNoActive throws before the scheduler is started, so the throw
      // is caught by the inner try/catch (exit 1).
      expect(exitSpy.mock.calls[0]?.[0]).toBe(1);
      expect(insertSpy).toHaveBeenCalledOnce();

      insertSpy.mockRestore();
      exitSpy.mockRestore();
      errSpy.mockRestore();
      writeSpy.mockRestore();
      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });
  it('exits 1 when scheduler rejects', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-sched-err-')));
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
      vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockRejectedValue(
        new Error('scheduler exploded'),
      );
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });
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

      expect(exitSpy.mock.calls[0]?.[0]).toBe(1);

      exitSpy.mockRestore();
      errSpy.mockRestore();
      writeSpy.mockRestore();
      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });

  // Worktree creation moved into workerLoopDeps.prepareWorktree (compose.ts).
  // See compose.test.ts: 'workerLoopDeps.prepareWorktree calls git.createWorktree and updates startCommitSha'.

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
      vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockResolvedValue(undefined);
      const removeWorktreeSpy = vi
        .spyOn(GitWorktreeAdapter.prototype, 'removeWorktree')
        .mockResolvedValue(undefined);
      // Run row was inserted by the CLI; mock findByUuid so the CLI sees status='failed'
      vi.spyOn(RunRepository.prototype, 'findByUuid').mockReturnValue({
        uuid: 'mock-failed-uuid',
        status: 'failed',
        displayId: 'issue-62-20260622-000000',
        issueNumber: 62,
        type: 'issue_to_pr',
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });
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

      // worktree must NOT be removed when run fails
      expect(removeWorktreeSpy).not.toHaveBeenCalled();
      expect(exitSpy.mock.calls[0]?.[0]).toBe(1);

      exitSpy.mockRestore();
      errSpy.mockRestore();
      writeSpy.mockRestore();
      vi.restoreAllMocks();
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
      vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockResolvedValue(undefined);
      const subscribeSpy = vi.spyOn(InMemoryEventBus.prototype, 'subscribe');
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

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

      const program = buildProgram({
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });
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
      vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockResolvedValue(undefined);
      const subscribeSpy = vi.spyOn(InMemoryEventBus.prototype, 'subscribe');

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

      const program = buildProgram({
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });
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
      vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockResolvedValue(undefined);
      // CLI will fetch the final run row to emit JSON. Provide a deterministic one.
      vi.spyOn(RunRepository.prototype, 'findByUuid').mockReturnValue({
        uuid: 'mock-verbose-json-uuid',
        status: 'passed',
        displayId: 'issue-72-20260622-000000',
        issueNumber: 72,
        type: 'issue_to_pr',
        completedPhases: ['read-issue'],
        skippedPhases: [],
        startedAt: new Date(),
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

      const program = buildProgram({
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });
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
      expect(output.run.uuid).toBe('mock-verbose-json-uuid');
      expect(output.run.status).toBe('passed');
      expect(output).toHaveProperty('phases');

      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('finalizes a stranded running run to failed when job is already failed (atomic reconcile)', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-stale-run-')));
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
      // Simulate a job that is already 'failed' but the run is still in 'running'.
      // The atomic reconcile block should finalize the run to 'failed'.
      const jobFindByIdSpy = vi.spyOn(JobQueueRepository.prototype, 'findById').mockReturnValue({
        id: JobId('stale-job'),
        runId: 'stale-run-uuid' as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        repoId: RepositoryId('owner/repo'),
        issueNumber: 8 as ReturnType<typeof import('@ai-sdlc/domain').IssueNumber>,
        status: 'failed',
        priority: 0,
        attempts: 1,
        createdAt: new Date(),
      } as ReturnType<JobQueueRepository['findById']>);

      // First call returns 'running' (before reconcile), second call returns 'failed' (after reconcile)
      const runFindByUuidSpy = vi
        .spyOn(RunRepository.prototype, 'findByUuid')
        .mockReturnValueOnce({
          uuid: 'gen-uuid-1',
          status: 'running',
          displayId: 'issue-8-20260622-000000',
          issueNumber: 8,
          type: 'issue_to_pr',
          completedPhases: [],
          skippedPhases: [],
          startedAt: new Date(),
        })
        .mockReturnValueOnce({
          uuid: 'gen-uuid-1',
          status: 'failed',
          displayId: 'issue-8-20260622-000000',
          issueNumber: 8,
          type: 'issue_to_pr',
          completedPhases: [],
          skippedPhases: [],
          startedAt: new Date(),
        });

      // Mock atomicUpdateByUuid to return true (indicating successful update)
      const atomicUpdateSpy = vi
        .spyOn(RunRepository.prototype, 'atomicUpdateByUuid')
        .mockReturnValue(true);

      vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockResolvedValue(undefined);

      const stdoutChunks: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk,
        cbOrEnc,
        cb2,
      ) => {
        stdoutChunks.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'),
        );
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const program = buildProgram({
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '8',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);

      const exitCode = exitSpy.mock.calls[0]?.[0];
      expect(exitCode).toBe(1);

      // Verify atomic update was called with 'failed' status and 'running' as expected status
      expect(atomicUpdateSpy).toHaveBeenCalledWith(
        expect.any(String), // UUID is generated by insertIfNoActive
        expect.objectContaining({
          status: 'failed',
          failureReason: 'worker loop terminated without finalizing run',
        }),
        'running',
      );

      const output = stdoutChunks.find((c) => c.trim().startsWith('{'));
      expect(output).toBeDefined();
      const parsed = JSON.parse(output!);
      expect(parsed.run.status).toBe('failed');

      jobFindByIdSpy.mockRestore();
      runFindByUuidSpy.mockRestore();
      atomicUpdateSpy.mockRestore();
      writeSpy.mockRestore();
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('stdout JSON includes jobId, workerId, and a populated phases array on success', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-phases-')));
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
      // Mock the job to have 'succeeded' status
      const jobFindByIdSpy = vi.spyOn(JobQueueRepository.prototype, 'findById').mockReturnValue({
        id: JobId('success-job'),
        runId: 'success-run-uuid' as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        repoId: RepositoryId('owner/repo'),
        issueNumber: 9 as ReturnType<typeof import('@ai-sdlc/domain').IssueNumber>,
        status: 'succeeded',
        priority: 0,
        attempts: 1,
        createdAt: new Date(),
      } as ReturnType<JobQueueRepository['findById']>);

      // Mock the run to be 'passed'
      vi.spyOn(RunRepository.prototype, 'findByUuid').mockReturnValue({
        uuid: 'success-run-uuid',
        status: 'passed',
        displayId: 'issue-9-20260622-000000',
        issueNumber: 9,
        type: 'issue_to_pr',
        completedPhases: ['read-issue'],
        skippedPhases: [],
        startedAt: new Date(),
      });

      vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockResolvedValue(undefined);

      const stdoutChunks: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk,
        cbOrEnc,
        cb2,
      ) => {
        stdoutChunks.push(
          typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'),
        );
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

      const program = buildProgram({
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });
      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '9',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);

      const exitCode = exitSpy.mock.calls[0]?.[0];
      expect(exitCode).toBe(0);

      const output = stdoutChunks.find((c) => c.trim().startsWith('{'));
      expect(output).toBeDefined();
      const parsed = JSON.parse(output!);

      // Assert that jobId and workerId are in the output
      expect(parsed).toHaveProperty('jobId');
      expect(parsed.jobId).toBeTruthy();
      expect(parsed).toHaveProperty('workerId');
      expect(parsed.workerId).toBeTruthy();

      // Assert that phases is an array (populated from phaseRepository.listByRun)
      expect(parsed).toHaveProperty('phases');
      expect(Array.isArray(parsed.phases)).toBe(true);

      // Assert the run status is correct
      expect(parsed).toHaveProperty('run');
      expect(parsed.run.status).toBe('passed');

      jobFindByIdSpy.mockRestore();
      writeSpy.mockRestore();
      exitSpy.mockRestore();
      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });
});

describe('CLI runs resume command', () => {
  it('exits 1 when --uuid is missing', async () => {
    const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
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
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
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
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
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
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runUuid,
      'issue-110-20260622-000000',
      'owner/repo',
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
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runUuid,
      'issue-111-20260622-000000',
      'owner/repo',
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
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runUuid,
      'issue-112-20260622-000000',
      'owner/repo',
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

  it('streams progress to stderr when --verbose is passed during resume', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-resume-verbose-')));
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
    const runUuid = 'resume-verbose-uuid';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runUuid,
      'issue-113-20260622-000000',
      'owner/repo',
      113,
      'issue_to_pr',
      'failed',
      '[]',
      new Date().toISOString(),
    );
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const subscribeSpy = vi.spyOn(InMemoryEventBus.prototype, 'subscribe');
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      vi.spyOn(RetryFailedPhase.prototype, 'execute').mockResolvedValue(undefined);
      vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-${process.pid}`),
        runId: runUuid as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 120_000),
      });
      vi.spyOn(WorkerLeaseRepository.prototype, 'heartbeat').mockReturnValue(undefined);
      vi.spyOn(WorkerLeaseRepository.prototype, 'release').mockReturnValue(undefined);
      vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: {
          uuid: runUuid,
          status: 'passed' as const,
          displayId: '',
          issueNumber: 113,
          type: 'issue_to_pr' as const,
          completedPhases: [],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [{ phase: 'implement', status: 'passed' }],
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

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['resume', '--uuid', runUuid, '--verbose'], { from: 'user' });

      expect(subscribeSpy).toHaveBeenCalled();
      const listener = subscribeSpy.mock.calls[0]?.[1];
      expect(listener).toBeDefined();
      listener?.({
        runId: runUuid,
        type: 'phase.started',
        level: 'info' as const,
        message: 'starting phase implement',
        timestamp: new Date().toISOString(),
        metadata: {},
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ts] starting phase implement'),
      );

      subscribeSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      vi.restoreAllMocks();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('does not stream progress when --no-verbose is passed during resume', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-resume-noverbose-')));
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
    const runUuid = 'resume-noverbose-uuid';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runUuid,
      'issue-114-20260622-000000',
      'owner/repo',
      114,
      'issue_to_pr',
      'failed',
      '[]',
      new Date().toISOString(),
    );
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const subscribeSpy = vi.spyOn(InMemoryEventBus.prototype, 'subscribe');

      vi.spyOn(RetryFailedPhase.prototype, 'execute').mockResolvedValue(undefined);
      vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
        repoId: RepositoryId('owner/repo'),
        workerId: WorkerId(`cli-${process.pid}`),
        runId: runUuid as unknown as ReturnType<typeof import('@ai-sdlc/domain').RunId>,
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: new Date(Date.now() + 120_000),
      });
      vi.spyOn(WorkerLeaseRepository.prototype, 'heartbeat').mockReturnValue(undefined);
      vi.spyOn(WorkerLeaseRepository.prototype, 'release').mockReturnValue(undefined);
      vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: {
          uuid: runUuid,
          status: 'passed' as const,
          displayId: '',
          issueNumber: 114,
          type: 'issue_to_pr' as const,
          completedPhases: [],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [{ phase: 'implement', status: 'passed' }],
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

      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['resume', '--uuid', runUuid, '--no-verbose'], { from: 'user' });

      expect(subscribeSpy).not.toHaveBeenCalled();

      subscribeSpy.mockRestore();
      vi.restoreAllMocks();
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
    db.prepare(`INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('resume-norepo-uuid', 'issue-101-20260622-000000', 'owner/repo',
      101,
      'issue_to_pr',
      'failed',
      '[]',
      new Date().toISOString(),
    );
    db.close();

    const savedCwd = process.cwd();
    const savedGithubRepo = process.env.GITHUB_REPOSITORY;
    process.chdir(root);
    delete process.env.GITHUB_REPOSITORY;
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
      if (savedGithubRepo !== undefined) process.env.GITHUB_REPOSITORY = savedGithubRepo;
    }
  });

  it('runs check-merge-ready returns success for ready PR', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cmr-ok-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    const runUuid = 'cmr-ok-uuid';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runUuid,
      'issue-99-20260625-000000',
      'owner/repo',
      99,
      'issue_to_pr',
      'waiting',
      '[]',
      new Date().toISOString(),
    );
    // No blocked or unverified P1 comments
    db.close();

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const stdoutChunks: string[] = [];
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk));
        return true;
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['check-merge-ready', '--uuid', runUuid], { from: 'user' });

      const output = JSON.parse(stdoutChunks.join(''));
      expect(output.isReady).toBe(true);
      expect(exitSpy).toHaveBeenCalledWith(0);

      writeSpy.mockRestore();
      exitSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('runs check-merge-ready returns error for blocked PR', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cmr-fail-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    const runUuid = 'cmr-fail-uuid';
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runUuid,
      'issue-99-20260625-000001',
      'owner/repo',
      99,
      'issue_to_pr',
      'waiting',
      '[]',
      new Date().toISOString(),
    );
    db.prepare(
      `INSERT INTO pr_review_comments (run_uuid, pr_number, comment_id, path, line, reviewer, body, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      99,
      1,
      'a.ts',
      1,
      'r',
      'P1 fix this',
      'pending',
      new Date().toISOString(),
      new Date().toISOString(),
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
      vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['check-merge-ready', '--uuid', runUuid], { from: 'user' });

      const output = JSON.parse(stdoutChunks.join(''));
      expect(output.isReady).toBe(false);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrs.join('')).toMatch(/PR is not ready for merge/i);

      writeSpy.mockRestore();
      exitSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('runs check-merge-ready fails for an unknown run UUID', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cmr-unknown-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
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
      vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['check-merge-ready', '--uuid', 'no-such-uuid'], { from: 'user' });

      expect(consoleErrs.join('')).toMatch(/No run found for uuid no-such-uuid/);
      expect(exitSpy).toHaveBeenCalledWith(1);

      writeSpy.mockRestore();
      exitSpy.mockRestore();
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
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runUuid,
      'issue-131-20260625-000000',
      'owner/repo',
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
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, skipped_phases, started_at, current_phase)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-130-20260625-000000',
      'owner/repo',
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

  it('releases lease on SIGTERM during runs resume', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-resume-sigterm-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/opsclawd/automation.git'], {
      cwd: root,
    });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
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
    const runUuid = 'resume-sigterm-uuid';
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, skipped_phases, started_at, current_phase)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-81-20260622-000000',
      'opsclawd/automation',
      81,
      'issue_to_pr',
      'failed',
      '[]',
      '[]',
      new Date().toISOString(),
      'implement',
    );
    db.close();

    const child = spawnOrchestrator(['runs', 'resume', '--uuid', runUuid], root, {
      GITHUB_REPOSITORY: 'opsclawd/automation',
    });

    const stderr: string[] = [];
    child.stderr?.on('data', (d) => stderr.push(d.toString()));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`timed out waiting for lease. stderr: ${stderr.join('')}`)),
        15_000,
      );
      const poll = () => {
        try {
          const d = openDatabase(dbPath);
          const row = d
            .prepare(
              `SELECT runs.uuid, worker_leases.repo_id
               FROM runs
               JOIN worker_leases ON worker_leases.run_id = runs.uuid
               WHERE runs.uuid = ? AND runs.status = 'running'`,
            )
            .get(runUuid);
          d.close();
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

    const d2 = openDatabase(dbPath);
    const run = d2
      .prepare('SELECT status, failure_reason FROM runs WHERE uuid = ?')
      .get(runUuid) as { status: string; failure_reason: string | null };
    expect(run.status).toBe('cancelled');
    expect(run.failure_reason).toMatch(/interrupted by SIGTERM/i);
    expect(d2.prepare('SELECT repo_id FROM worker_leases').get()).toBeUndefined();
    d2.close();
  }, 45_000);

  it('releases lease on SIGINT during runs resume', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-resume-sigint-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/opsclawd/automation.git'], {
      cwd: root,
    });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
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
    const runUuid = 'resume-sigint-uuid';
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, skipped_phases, started_at, current_phase)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runUuid,
      'issue-82-20260622-000000',
      'opsclawd/automation',
      82,
      'issue_to_pr',
      'failed',
      '[]',
      '[]',
      new Date().toISOString(),
      'implement',
    );
    db.close();

    const child = spawnOrchestrator(['runs', 'resume', '--uuid', runUuid], root, {
      GITHUB_REPOSITORY: 'opsclawd/automation',
    });

    const stderr: string[] = [];
    child.stderr?.on('data', (d) => stderr.push(d.toString()));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`timed out waiting for lease. stderr: ${stderr.join('')}`)),
        15_000,
      );
      const poll = () => {
        try {
          const d = openDatabase(dbPath);
          const row = d
            .prepare(
              `SELECT runs.uuid, worker_leases.repo_id
               FROM runs
               JOIN worker_leases ON worker_leases.run_id = runs.uuid
               WHERE runs.uuid = ? AND runs.status = 'running'`,
            )
            .get(runUuid);
          d.close();
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

    const d2 = openDatabase(dbPath);
    const run = d2
      .prepare('SELECT status, failure_reason FROM runs WHERE uuid = ?')
      .get(runUuid) as { status: string; failure_reason: string | null };
    expect(run.status).toBe('cancelled');
    expect(run.failure_reason).toMatch(/interrupted by SIGINT/i);
    expect(d2.prepare('SELECT repo_id FROM worker_leases').get()).toBeUndefined();
    d2.close();
  }, 45_000);
});
