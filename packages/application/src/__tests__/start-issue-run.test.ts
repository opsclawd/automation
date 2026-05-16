import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openDatabase,
  applyMigrations,
  RunRepository,
  RunDirectory,
} from '@ai-sdlc/infrastructure';
import { StartIssueRun } from '../start-issue-run.js';

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

function fakeScript(exitCode: number, stdout = 'hello', stderr = ''): string {
  const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-fake-')));
  const path = join(dir, 'ai-run.sh');
  writeFileSync(
    path,
    `#!/usr/bin/env bash\necho '${stdout}'\n${stderr ? `echo '${stderr}' 1>&2\n` : ''}exit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

describe('StartIssueRun', () => {
  it('creates a run row, directory, logs, and updates status on success', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-run-')));
    const db = openDatabase(join(root, 'orch.sqlite'));
    applyMigrations(db);
    const repo = new RunRepository(db);
    const usecase = new StartIssueRun({
      runRepository: repo,
      runsDir: join(root, '.ai-runs'),
      scriptPath: fakeScript(0, 'plan done'),
      now: () => new Date('2026-05-13T19:23:00Z'),
    });
    const out = await usecase.execute({ issueNumber: 42 });
    expect(out.displayId).toBe('issue-42-20260513-192300');
    expect(out.status).toBe('passed');
    expect(out.exitCode).toBe(0);
    expect(out.uuid).toBeTruthy();
    const paths = RunDirectory.paths(join(root, '.ai-runs'), out.displayId);
    expect(existsSync(paths.runJsonPath)).toBe(true);
    expect(readFileSync(paths.stdoutLogPath, 'utf8')).toContain('plan done');
    expect(existsSync(paths.stderrLogPath)).toBe(true);
    expect(existsSync(paths.combinedLogPath)).toBe(true);
    const row = repo.findByUuid(out.uuid);
    expect(row?.status).toBe('passed');
    expect(row?.exitCode).toBe(0);
    expect(row?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('marks the run failed on non-zero exit', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-run-')));
    const db = openDatabase(join(root, 'orch.sqlite'));
    applyMigrations(db);
    const repo = new RunRepository(db);
    const usecase = new StartIssueRun({
      runRepository: repo,
      runsDir: join(root, '.ai-runs'),
      scriptPath: fakeScript(3, 'some output', 'stderr msg'),
      now: () => new Date('2026-05-13T19:23:00Z'),
    });
    const out = await usecase.execute({ issueNumber: 99 });
    expect(out.status).toBe('failed');
    expect(out.exitCode).toBe(3);
    const row = repo.findByUuid(out.uuid);
    expect(row?.status).toBe('failed');
    expect(row?.exitCode).toBe(3);
    expect(row?.failureReason).toBeTruthy();
  });

  it('refuses to start a second active run for the same issue', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-run-')));
    const db = openDatabase(join(root, 'orch.sqlite'));
    applyMigrations(db);
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'existing-uuid',
      displayId: 'issue-7-20260513-000000',
      issueNumber: 7,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    const usecase = new StartIssueRun({
      runRepository: repo,
      runsDir: join(root, '.ai-runs'),
      scriptPath: fakeScript(0),
      now: () => new Date('2026-05-13T19:23:00Z'),
    });
    await expect(usecase.execute({ issueNumber: 7 })).rejects.toThrow(/active run/i);
  });

  it('sets AI_RUN_UUID, AI_RUN_DISPLAY_ID, AI_RUN_DIR, AI_ISSUE_NUMBER in child env', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-run-')));
    const db = openDatabase(join(root, 'orch.sqlite'));
    applyMigrations(db);
    const repo = new RunRepository(db);
    const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-env-')));
    const script = join(dir, 'print-env.sh');
    writeFileSync(script, `#!/usr/bin/env bash\nenv | grep AI_ | sort\nexit 0\n`);
    chmodSync(script, 0o755);
    const now = new Date('2026-05-13T19:23:00Z');
    const usecase = new StartIssueRun({
      runRepository: repo,
      runsDir: join(root, '.ai-runs'),
      scriptPath: script,
      now: () => now,
    });
    const out = await usecase.execute({ issueNumber: 5 });
    const logContent = readFileSync(
      RunDirectory.paths(join(root, '.ai-runs'), out.displayId).stdoutLogPath,
      'utf8',
    );
    expect(logContent).toContain('AI_RUN_UUID=');
    expect(logContent).toContain('AI_RUN_DISPLAY_ID=issue-5-20260513-192300');
    expect(logContent).toContain('AI_RUN_DIR=');
    expect(logContent).toContain('AI_ISSUE_NUMBER=5');
  });

  it('passes optional env vars only when deps are provided', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-run-')));
    const db = openDatabase(join(root, 'orch.sqlite'));
    applyMigrations(db);
    const repo = new RunRepository(db);
    const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-env-')));
    const script = join(dir, 'print-env.sh');
    writeFileSync(script, `#!/usr/bin/env bash\nenv | grep AI_ | sort\nexit 0\n`);
    chmodSync(script, 0o755);
    const usecase = new StartIssueRun({
      runRepository: repo,
      runsDir: join(root, '.ai-runs'),
      scriptPath: script,
      baseBranch: 'develop',
      model: 'gpt-4',
      agentCli: 'codex',
      now: () => new Date('2026-05-13T19:23:00Z'),
    });
    const out = await usecase.execute({ issueNumber: 10 });
    const logContent = readFileSync(
      RunDirectory.paths(join(root, '.ai-runs'), out.displayId).stdoutLogPath,
      'utf8',
    );
    expect(logContent).toContain('AI_BASE_BRANCH=develop');
    expect(logContent).toContain('AI_MODEL=gpt-4');
    expect(logContent).toContain('AI_RUNTIME=codex');
  });
});
