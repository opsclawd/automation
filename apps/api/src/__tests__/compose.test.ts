import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot } from '../compose.js';
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
  const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
  const path = join(dir, 'run.sh');
  writeFileSync(path, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('composeRoot', () => {
  it('wires dependencies correctly and can execute a run against a fake script', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const container = composeRoot({
      repoRoot: root,
      scriptPath,
    });

    expect(container.runRepository).toBeDefined();
    expect(container.phaseRepository).toBeDefined();
    expect(container.eventRepository).toBeDefined();
    expect(container.artifactRepository).toBeDefined();
    expect(container.failureRepository).toBeDefined();
    expect(container.startIssueRun).toBeDefined();
    expect(container.runsDir).toBe(join(root, '.ai-runs'));

    const out = await container.startIssueRun.execute({ issueNumber: 1 });
    expect(out.status).toBe('passed');
    expect(out.exitCode).toBe(0);
    expect(out.uuid).toBeTruthy();

    const row = container.runRepository.findByUuid(out.uuid);
    expect(row?.status).toBe('passed');
  });

  it('passes optional deps through to StartIssueRun', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = join(dir, 'env.sh');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\necho "BRANCH=$AI_BASE_BRANCH MODEL=$AI_AGENT_MODEL RUNTIME=$AI_RUNTIME"\nexit 0\n`,
    );
    chmodSync(scriptPath, 0o755);

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      baseBranch: 'develop',
      model: 'gpt-4',
      agentCli: 'codex',
    });

    const out = await container.startIssueRun.execute({ issueNumber: 2 });
    expect(out.status).toBe('passed');
  });

  it('classifies failure from phase.failed event end-to-end', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = join(dir, 'fail-with-event.sh');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash
mkdir -p "$(dirname "$AI_RUN_EVENTS_FILE")"
echo '{"runId":"'"$AI_RUN_DISPLAY_ID"'","phase":"validate","level":"error","type":"phase.failed","message":"pnpm build failed","timestamp":"2026-05-18T10:00:00.000Z","metadata":{"command":"pnpm build","exitCode":2}}' >> "$AI_RUN_EVENTS_FILE"
sleep 0.3
exit 1
`,
    );
    chmodSync(scriptPath, 0o755);

    const container = composeRoot({
      repoRoot: root,
      scriptPath,
    });

    const out = await container.startIssueRun.execute({ issueNumber: 42 });
    expect(out.status).toBe('failed');
    expect(out.exitCode).toBe(1);

    const failure = container.failureRepository.findLatestByRun(out.uuid);
    expect(failure).toBeDefined();
    expect(failure!.kind).toBe('validation_failed');
    expect(failure!.phase).toBe('validate');
    expect(failure!.exitCode).toBe(2);
    expect(failure!.message).toMatch(/pnpm build/);

    const runDir = join(container.runsDir, out.displayId);
    if (existsSync(join(runDir, 'failure.json'))) {
      const failureJson = JSON.parse(readFileSync(join(runDir, 'failure.json'), 'utf-8'));
      expect(failureJson.kind).toBe('validation_failed');
      expect(failureJson.phase).toBe('validate');
    }
  });

  it('sweeps orphaned runs on compose', () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    // Manually insert a "running" row with a dead PID
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at, pid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'dead-pid-uuid',
      'issue-999-20260513-000000',
      999,
      'issue_to_pr',
      'running',
      '[]',
      new Date().toISOString(),
      999999,
    );
    db.close();
    // Compose should sweep it
    const container = composeRoot({ repoRoot: root, scriptPath });
    const run = container.runRepository.findByUuid('dead-pid-uuid');
    expect(run?.status).toBe('cancelled');
    expect(run?.failureReason).toMatch(/orphaned/);
  });

  it('creates .ai-tmp/ directory at compose time', () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      composeRoot({ repoRoot: root, scriptPath });
      expect(existsSync(join(root, '.ai-tmp'))).toBe(true);
      expect(statSync(join(root, '.ai-tmp')).isDirectory()).toBe(true);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });

  it('sets TMPDIR/SQLITE_TMPDIR in child env to per-run tmp dir', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = join(dir, 'check-env.sh');
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\necho "TMPDIR=$TMPDIR"\necho "SQLITE_TMPDIR=$SQLITE_TMPDIR"\nexit 0\n`,
    );
    chmodSync(scriptPath, 0o755);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const container = composeRoot({ repoRoot: root, scriptPath });
      const out = await container.startIssueRun.execute({ issueNumber: 1 });
      const runDir = join(container.runsDir, out.displayId);
      const combined = readFileSync(join(runDir, 'combined.log'), 'utf8');
      expect(combined).toContain('TMPDIR=');
      expect(combined).toContain('SQLITE_TMPDIR=');
      expect(combined).toContain(out.uuid);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });

  it('respects operator-set TMPDIR and nests per-run tmp dirs under it', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const customTmp = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-custom-tmp-')));
    const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = join(dir, 'check-tmpdir.sh');
    writeFileSync(scriptPath, `#!/usr/bin/env bash\necho "TMPDIR=$TMPDIR"\nexit 0\n`);
    chmodSync(scriptPath, 0o755);
    const origTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = customTmp;
    try {
      const container = composeRoot({ repoRoot: root, scriptPath });
      expect(container.baseTmpDir).toBe(join(customTmp, '.ai-tmp'));
      const out = await container.startIssueRun.execute({ issueNumber: 2 });
      const runDir = join(container.runsDir, out.displayId);
      const combined = readFileSync(join(runDir, 'combined.log'), 'utf8');
      expect(combined).toContain(`TMPDIR=${join(customTmp, '.ai-tmp', out.uuid)}`);
    } finally {
      if (origTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = origTmpdir;
      }
    }
  });

  it('sweeps orphaned tmp dirs on compose', () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
      const db = openDatabase(dbPath);
      applyMigrations(db);
      db.prepare(
        `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'completed-uuid',
        'issue-888-20260513-000000',
        888,
        'issue_to_pr',
        'passed',
        '[]',
        new Date().toISOString(),
      );
      db.close();
      const tmpBase = join(root, '.ai-tmp');
      mkdirSync(tmpBase, { recursive: true });
      const orphanTmpDir = join(tmpBase, 'completed-uuid');
      mkdirSync(orphanTmpDir, { recursive: true });
      writeFileSync(join(orphanTmpDir, 'test.tmp'), 'orphan');
      expect(existsSync(orphanTmpDir)).toBe(true);
      composeRoot({ repoRoot: root, scriptPath });
      expect(existsSync(orphanTmpDir)).toBe(false);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });

  it('skips orphan and tmp-dir sweeps when runStartupSweeps is false', () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
      const db = openDatabase(dbPath);
      applyMigrations(db);
      db.prepare(
        `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at, pid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'dead-pid-uuid',
        'issue-777-20260513-000000',
        777,
        'issue_to_pr',
        'running',
        '[]',
        new Date().toISOString(),
        999999,
      );
      db.prepare(
        `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'completed-uuid',
        'issue-888-20260513-000000',
        888,
        'issue_to_pr',
        'passed',
        '[]',
        new Date().toISOString(),
      );
      db.close();

      const tmpBase = join(root, '.ai-tmp');
      mkdirSync(tmpBase, { recursive: true });
      const deadPidTmpDir = join(tmpBase, 'dead-pid-uuid');
      mkdirSync(deadPidTmpDir, { recursive: true });
      writeFileSync(join(deadPidTmpDir, 'prompt.md'), 'important prompt');
      const completedTmpDir = join(tmpBase, 'completed-uuid');
      mkdirSync(completedTmpDir, { recursive: true });
      writeFileSync(join(completedTmpDir, 'leftover.tmp'), 'data');

      composeRoot({ repoRoot: root, scriptPath, runStartupSweeps: false });

      expect(existsSync(deadPidTmpDir)).toBe(true);
      expect(existsSync(join(deadPidTmpDir, 'prompt.md'))).toBe(true);
      expect(existsSync(completedTmpDir)).toBe(true);
      expect(existsSync(join(completedTmpDir, 'leftover.tmp'))).toBe(true);

      const container2 = composeRoot({ repoRoot: root, scriptPath });
      expect(container2.runRepository.findByUuid('dead-pid-uuid')?.status).toBe('cancelled');
      expect(existsSync(completedTmpDir)).toBe(false);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });

  it('does not sweep tmp dirs for unknown UUIDs', () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const tmpBase = join(root, '.ai-tmp');
      mkdirSync(tmpBase, { recursive: true });
      const unknownTmpDir = join(tmpBase, 'unknown-uuid-from-another-instance');
      mkdirSync(unknownTmpDir, { recursive: true });
      writeFileSync(join(unknownTmpDir, 'test.tmp'), 'active run from another repo');
      expect(existsSync(unknownTmpDir)).toBe(true);
      composeRoot({ repoRoot: root, scriptPath });
      expect(existsSync(unknownTmpDir)).toBe(true);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });

  it('removes per-run tmp dir after a passing run completes', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const container = composeRoot({ repoRoot: root, scriptPath });
      const out = await container.startIssueRun.execute({ issueNumber: 3 });
      const tmpRunDir = join(container.baseTmpDir, out.uuid);
      expect(existsSync(tmpRunDir)).toBe(false);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });

  it('removes per-run tmp dir after a failed run completes', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(1);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const container = composeRoot({ repoRoot: root, scriptPath });
      const out = await container.startIssueRun.execute({ issueNumber: 4 });
      const tmpRunDir = join(container.baseTmpDir, out.uuid);
      expect(out.status).toBe('failed');
      expect(existsSync(tmpRunDir)).toBe(false);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });
});
