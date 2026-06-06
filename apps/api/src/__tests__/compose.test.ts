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
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot } from '../compose.js';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';
import { RunId, RepositoryId, PhaseName } from '@ai-sdlc/domain';
import type { PrReviewPollerDeps } from '@ai-sdlc/application';

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
  const dir = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
  const scriptPath = path.join(dir, 'run.sh');
  writeFileSync(scriptPath, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('composeRoot', () => {
  it('wires dependencies correctly and can execute a run against a fake script', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
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
    expect(container.runsDir).toBe(path.join(root, '.ai-runs'));

    const out = await container.startIssueRun.execute({ issueNumber: 1 });
    expect(out.status).toBe('passed');
    expect(out.exitCode).toBe(0);
    expect(out.uuid).toBeTruthy();

    const row = container.runRepository.findByUuid(out.uuid);
    expect(row?.status).toBe('passed');
  });

  it('exposes validationRunRepository', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const container = composeRoot({ repoRoot: root, scriptPath });
    expect(container.validationRunRepository).toBeDefined();
    expect(typeof container.validationRunRepository.listByRun).toBe('function');
  });

  it('exposes prReviewRepository', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const container = composeRoot({ repoRoot: root, scriptPath });
    expect(container.prReviewRepository).toBeDefined();
    expect(typeof container.prReviewRepository.listComments).toBe('function');
  });

  it('passes optional deps through to StartIssueRun', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const dir = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = path.join(dir, 'env.sh');
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
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const dir = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = path.join(dir, 'fail-with-event.sh');
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

    const runDir = path.join(container.runsDir, out.displayId);
    if (existsSync(path.join(runDir, 'failure.json'))) {
      const failureJson = JSON.parse(readFileSync(path.join(runDir, 'failure.json'), 'utf-8'));
      expect(failureJson.kind).toBe('validation_failed');
      expect(failureJson.phase).toBe('validate');
    }
  });

  it('sweeps orphaned runs on compose', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    // Manually insert a "running" row with a dead PID
    const dbPath = path.join(root, '.ai-runs', 'orchestrator.sqlite');
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
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      composeRoot({ repoRoot: root, scriptPath });
      expect(existsSync(path.join(root, '.ai-tmp'))).toBe(true);
      expect(statSync(path.join(root, '.ai-tmp')).isDirectory()).toBe(true);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });

  it('sets TMPDIR/SQLITE_TMPDIR in child env to per-run tmp dir', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const dir = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = path.join(dir, 'check-env.sh');
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
      const runDir = path.join(container.runsDir, out.displayId);
      const combined = readFileSync(path.join(runDir, 'combined.log'), 'utf8');
      expect(combined).toContain('TMPDIR=');
      expect(combined).toContain('SQLITE_TMPDIR=');
      expect(combined).toContain(out.uuid);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });

  it('respects operator-set TMPDIR and nests per-run tmp dirs under it', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const customTmp = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-custom-tmp-')));
    const dir = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = path.join(dir, 'check-tmpdir.sh');
    writeFileSync(scriptPath, `#!/usr/bin/env bash\necho "TMPDIR=$TMPDIR"\nexit 0\n`);
    chmodSync(scriptPath, 0o755);
    const origTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = customTmp;
    try {
      const container = composeRoot({ repoRoot: root, scriptPath });
      expect(container.baseTmpDir).toBe(path.join(customTmp, '.ai-tmp'));
      const out = await container.startIssueRun.execute({ issueNumber: 2 });
      const runDir = path.join(container.runsDir, out.displayId);
      const combined = readFileSync(path.join(runDir, 'combined.log'), 'utf8');
      expect(combined).toContain(`TMPDIR=${path.join(customTmp, '.ai-tmp', out.uuid)}`);
    } finally {
      if (origTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = origTmpdir;
      }
    }
  });

  it('sweeps orphaned tmp dirs on compose', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const dbPath = path.join(root, '.ai-runs', 'orchestrator.sqlite');
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
      const tmpBase = path.join(root, '.ai-tmp');
      mkdirSync(tmpBase, { recursive: true });
      const orphanTmpDir = path.join(tmpBase, 'completed-uuid');
      mkdirSync(orphanTmpDir, { recursive: true });
      writeFileSync(path.join(orphanTmpDir, 'test.tmp'), 'orphan');
      expect(existsSync(orphanTmpDir)).toBe(true);
      composeRoot({ repoRoot: root, scriptPath });
      expect(existsSync(orphanTmpDir)).toBe(false);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });

  it('skips orphan and tmp-dir sweeps when runStartupSweeps is false', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const dbPath = path.join(root, '.ai-runs', 'orchestrator.sqlite');
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

      const tmpBase = path.join(root, '.ai-tmp');
      mkdirSync(tmpBase, { recursive: true });
      const deadPidTmpDir = path.join(tmpBase, 'dead-pid-uuid');
      mkdirSync(deadPidTmpDir, { recursive: true });
      writeFileSync(path.join(deadPidTmpDir, 'prompt.md'), 'important prompt');
      const completedTmpDir = path.join(tmpBase, 'completed-uuid');
      mkdirSync(completedTmpDir, { recursive: true });
      writeFileSync(path.join(completedTmpDir, 'leftover.tmp'), 'data');

      composeRoot({ repoRoot: root, scriptPath, runStartupSweeps: false });

      expect(existsSync(deadPidTmpDir)).toBe(true);
      expect(existsSync(path.join(deadPidTmpDir, 'prompt.md'))).toBe(true);
      expect(existsSync(completedTmpDir)).toBe(true);
      expect(existsSync(path.join(completedTmpDir, 'leftover.tmp'))).toBe(true);

      const container2 = composeRoot({ repoRoot: root, scriptPath });
      expect(container2.runRepository.findByUuid('dead-pid-uuid')?.status).toBe('cancelled');
      expect(existsSync(completedTmpDir)).toBe(false);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });

  it('does not sweep tmp dirs for unknown UUIDs', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const tmpBase = path.join(root, '.ai-tmp');
      mkdirSync(tmpBase, { recursive: true });
      const unknownTmpDir = path.join(tmpBase, 'unknown-uuid-from-another-instance');
      mkdirSync(unknownTmpDir, { recursive: true });
      writeFileSync(path.join(unknownTmpDir, 'test.tmp'), 'active run from another repo');
      expect(existsSync(unknownTmpDir)).toBe(true);
      composeRoot({ repoRoot: root, scriptPath });
      expect(existsSync(unknownTmpDir)).toBe(true);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });

  it('removes per-run tmp dir after a passing run completes', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const container = composeRoot({ repoRoot: root, scriptPath });
      const out = await container.startIssueRun.execute({ issueNumber: 3 });
      const tmpRunDir = path.join(container.baseTmpDir, out.uuid);
      expect(existsSync(tmpRunDir)).toBe(false);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });

  it('exposes runValidation use case', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const c = composeRoot({ repoRoot: root, scriptPath });
    expect(c.runValidation).toBeDefined();
    expect(typeof c.runValidation.execute).toBe('function');
  });

  it('removes per-run tmp dir after a failed run completes', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(1);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const container = composeRoot({ repoRoot: root, scriptPath });
      const out = await container.startIssueRun.execute({ issueNumber: 4 });
      const tmpRunDir = path.join(container.baseTmpDir, out.uuid);
      expect(out.status).toBe('failed');
      expect(existsSync(tmpRunDir)).toBe(false);
    } finally {
      if (origTmpdir !== undefined) process.env.TMPDIR = origTmpdir;
      else delete process.env.TMPDIR;
    }
  });

  it('exposes a buildPrReviewPoller factory', () => {
    const c = composeRoot({
      repoRoot: trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-'))),
      scriptPath: 'scripts/ai-run-issue-v2',
      dbPath: ':memory:',
    });
    expect(typeof c.buildPrReviewPoller).toBe('function');
  });

  it(
    'wires processOnePass to ProcessPrReviewComments (no stub throw)',
    { timeout: 15000 },
    async () => {
      const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
      writeFileSync(
        path.join(root, '.ai-orchestrator.json'),
        JSON.stringify({
          validation: { commands: ['echo ok'], timeout: 60 },
          phases: {
            skip: [],
            reviewFix: { maxIterations: 3 },
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
              'post-pr-review': { profile: 'test' },
            },
          },
        }),
      );
      const c = composeRoot({
        repoRoot: root,
        scriptPath: '/dev/null',
        runStartupSweeps: false,
      });
      const poller = c.buildPrReviewPoller({
        maxPolls: 1,
        pollIntervalMs: 1000,
        readyMaxDays: 7,
        phaseStartedAt: new Date(),
      });
      const deps = (poller as unknown as { deps: PrReviewPollerDeps }).deps;
      // Intentional white-box: PrReviewPoller does not expose `deps` on its public
      // surface. We cast to the internal shape to assert the M6-05 wiring contract
      // (processOnePass delegates to ProcessPrReviewComments, not a stub throw).
      // If PrReviewPoller's internal field naming changes, this test must be
      // updated to match the new shape.
      await expect(
        deps.processOnePass({
          runId: RunId('test'),
          repoId: RepositoryId('o/r'),
          repoFullName: 'o/r',
          prNumber: 1,
          cwd: root,
          phaseId: PhaseName('post-pr-review'),
          pollNumber: 1,
        }),
      ).rejects.not.toThrow('processOnePass not wired — wire ProcessPrReviewComments in M6-05');
    },
  );

  it('throws ConfigError when buildPrReviewPoller is called without agent config', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const c = composeRoot({
      repoRoot: root,
      scriptPath: '/dev/null',
      runStartupSweeps: false,
    });
    expect(() =>
      c.buildPrReviewPoller({
        maxPolls: 1,
        pollIntervalMs: 1000,
        readyMaxDays: 7,
        phaseStartedAt: new Date(),
      }),
    ).toThrow(/agent config required/);
  });
});
