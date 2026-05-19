import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, findRepoRoot } from '../cli.js';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';

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
    expect(findRepoRoot(dir)).toBe(dir);
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
    // Make findRepoRoot stop here
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    // Insert a "running" row directly into the DB
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
      process.pid,
    );
    db.close();

    // chdir into temp dir so findRepoRoot returns root
    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      // Now cancel it
      const consoleErrs: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const program = buildProgram();
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['cancel', '--issue', '50'], { from: 'user' });
      spy.mockRestore();
      expect(consoleErrs.join('')).toMatch(/cancelled successfully/i);
    } finally {
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
});
