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
import * as childProcess from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeRoot, captureExecOutput, type ComposeOptions } from '../compose.js';
import { openDatabase, applyMigrations, GitWorktreeAdapter } from '@ai-sdlc/infrastructure';
import { RunId, RepositoryId, PhaseName, AgentProfileName, Step } from '@ai-sdlc/domain';
import {
  ReviewFixLoop,
  RunExecutor,
  ReadIssueHandler,
  PlanDesignHandler,
  PlanWriteHandler,
  ImplementHandler,
  ValidateHandler,
  ReviewFixHandler,
  CompoundHandler,
  CreatePrHandler,
  PostPrReviewHandler,
} from '@ai-sdlc/application';
import { FakeLoopRepository } from '@ai-sdlc/application/test-doubles';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { PrReviewPollerDeps, PostFixGateResult } from '@ai-sdlc/application';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(
      (
        file: Parameters<typeof actual.execFileSync>[0],
        args: Parameters<typeof actual.execFileSync>[1],
        options: Parameters<typeof actual.execFileSync>[2],
      ) => actual.execFileSync(file, args, options),
    ),
  };
});

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

const FAKE_METADATA_RESOLVER: ComposeOptions['metadataResolver'] = {
  resolve: (p) => ({
    rootPath: p,
    nameWithOwner: 'owner/repo',
    defaultBranch: 'main',
    remoteUrl: 'https://github.com/owner/repo.git',
  }),
};

describe('composeRoot', () => {
  it('wires dependencies correctly and can execute a run against a fake script', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const container = composeRoot({
      repoRoot: root,
      scriptPath,
      metadataResolver: FAKE_METADATA_RESOLVER,
    });

    expect(container.runRepository).toBeDefined();
    expect(container.phaseRepository).toBeDefined();
    expect(container.eventRepository).toBeDefined();
    expect(container.artifactRepository).toBeDefined();
    expect(container.failureRepository).toBeDefined();
    expect(container.startIssueRun).toBeDefined();
    expect(container.runsDir).toBe(path.join(root, '.ai-runs'));
    expect(container.buildPhaseHandlerContext).toBeDefined();

    const out = await container.startIssueRun.execute({
      issueNumber: 1,
      repoId: RepositoryId('owner/repo'),
    });
    expect(out.status).toBe('passed');
    expect(out.exitCode).toBe(0);
    expect(out.uuid).toBeTruthy();

    const row = container.runRepository.findByUuid(out.uuid);
    expect(row?.status).toBe('passed');
  });

  it('throws when metadata resolution fails for an explicit targetRepoRoot', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const target = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-target-')));
    const scriptPath = fakeScript(0);
    const throwingResolver: ComposeOptions['metadataResolver'] = {
      resolve: () => {
        throw new Error('not a git repository');
      },
    };
    expect(() =>
      composeRoot({
        repoRoot: root,
        targetRepoRoot: target,
        scriptPath,
        metadataResolver: throwingResolver,
      }),
    ).toThrow(
      /Failed to resolve repository metadata for --target-repo-root .*not a git repository/,
    );
  });

  it('falls back to GITHUB_REPOSITORY only when no explicit target is supplied', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const throwingResolver: ComposeOptions['metadataResolver'] = {
      resolve: () => {
        throw new Error('not a git repository');
      },
    };
    const orig = process.env.GITHUB_REPOSITORY;
    process.env.GITHUB_REPOSITORY = 'ambient/fallback';
    try {
      const container = composeRoot({
        repoRoot: root,
        scriptPath,
        metadataResolver: throwingResolver,
      });
      expect(container.repoFullName).toBe('ambient/fallback');
    } finally {
      if (orig !== undefined) process.env.GITHUB_REPOSITORY = orig;
      else delete process.env.GITHUB_REPOSITORY;
    }
  });

  it('buildPhaseHandlerContext adds idFactory and resolveProfile from compose wiring', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const container = composeRoot({
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoRoot: root,
      scriptPath,
    });

    const ctx = container.buildPhaseHandlerContext(
      {
        runId: 'test-run',
        runUuid: '550e8400-e29b-41d4-a716-446655440000',
        repoFullName: 'acme/widgets',
        issueNumber: 1,
        cwd: '/tmp',
        artifacts: container.artifactRepository,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        github: {} as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        git: {} as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agent: {} as any,
        events: container.eventBus,
        now: () => new Date(),
      },
      {
        promptsRoot: '/prompts',
        startCommitSha: 'abc123',
      },
    );

    // Compose root should populate idFactory (always)
    expect(ctx.idFactory).toBeDefined();
    expect(typeof ctx.idFactory).toBe('function');
    // resolveProfile will be defined when agentConfig is present (ee use case)
    // For the test repo (no config), it may be undefined — that's expected
    // Caller-supplied fields must pass through
    expect(ctx.promptsRoot).toBe('/prompts');
    expect(ctx.startCommitSha).toBe('abc123');
    // Base fields must be preserved
    expect(ctx.runId).toBe('test-run');
    expect(ctx.issueNumber).toBe(1);
  });

  it('exposes validationRunRepository', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const container = composeRoot({
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoRoot: root,
      scriptPath,
    });
    expect(container.validationRunRepository).toBeDefined();
    expect(typeof container.validationRunRepository.listByRun).toBe('function');
  });

  it('exposes prReviewRepository', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const container = composeRoot({
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoRoot: root,
      scriptPath,
    });
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
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoRoot: root,
      scriptPath,
      baseBranch: 'develop',
      model: 'gpt-4',
      agentCli: 'codex',
    });

    const out = await container.startIssueRun.execute({
      issueNumber: 2,
      repoId: RepositoryId('owner/repo'),
    });
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
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoRoot: root,
      scriptPath,
    });

    const out = await container.startIssueRun.execute({
      issueNumber: 42,
      repoId: RepositoryId('owner/repo'),
    });
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

  it('sweeps orphaned runs on compose and restores them to a non-terminal state', () => {
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
    // Compose should sweep the dead PID and the orphan sweeper should
    // re-drive it back to running (no skip paths taken in this scenario).
    const container = composeRoot({
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoRoot: root,
      scriptPath,
    });
    const run = container.runRepository.findByUuid('dead-pid-uuid');
    expect(run?.status).toBe('running');
  });

  it('creates .ai-tmp/ directory at compose time', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });
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
      const container = composeRoot({
        metadataResolver: FAKE_METADATA_RESOLVER,
        repoRoot: root,
        scriptPath,
      });
      const out = await container.startIssueRun.execute({
        issueNumber: 1,
        repoId: RepositoryId('owner/repo'),
      });
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
      const container = composeRoot({
        metadataResolver: FAKE_METADATA_RESOLVER,
        repoRoot: root,
        scriptPath,
      });
      expect(container.baseTmpDir).toBe(path.join(customTmp, '.ai-tmp'));
      const out = await container.startIssueRun.execute({
        issueNumber: 2,
        repoId: RepositoryId('owner/repo'),
      });
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
      composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });
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

      composeRoot({
        metadataResolver: FAKE_METADATA_RESOLVER,
        repoRoot: root,
        scriptPath,
        runStartupSweeps: false,
      });

      expect(existsSync(deadPidTmpDir)).toBe(true);
      expect(existsSync(path.join(deadPidTmpDir, 'prompt.md'))).toBe(true);
      expect(existsSync(completedTmpDir)).toBe(true);
      expect(existsSync(path.join(completedTmpDir, 'leftover.tmp'))).toBe(true);

      const container2 = composeRoot({
        metadataResolver: FAKE_METADATA_RESOLVER,
        repoRoot: root,
        scriptPath,
      });
      expect(container2.runRepository.findByUuid('dead-pid-uuid')?.status).toBe('running');
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
      composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });
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
      const container = composeRoot({
        metadataResolver: FAKE_METADATA_RESOLVER,
        repoRoot: root,
        scriptPath,
      });
      const out = await container.startIssueRun.execute({
        issueNumber: 3,
        repoId: RepositoryId('owner/repo'),
      });
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
    const c = composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });
    expect(c.runValidation).toBeDefined();
    expect(typeof c.runValidation.execute).toBe('function');
  });

  it('exposes loopRepository and reviewFixLoop', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    writeFileSync(
      path.join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        validation: { commands: ['echo ok'], timeout: 60 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 3 },
          implement: { maxIterations: 3 },
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
    const c = composeRoot({
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoRoot: root,
      scriptPath: '/dev/null',
      runStartupSweeps: false,
    });
    expect(c.loopRepository).toBeDefined();
    expect(c.reviewFixLoop).toBeDefined();
    expect(typeof c.reviewFixLoop!.execute).toBe('function');

    const container = c;
    // Issue #623: ReviewFixLoop must be wired with the evidence inspector
    // and the artifact store so the rebuttal-aware convergence branch can run.
    expect(container.reviewFixLoop).toBeDefined();
    // Internal check via the existing public surface — no direct field access.
    // The real assertion lives in the per-component tests for review-fix-loop.ts.
  });

  it('exposes runExecutor and phaseRegistry on the container', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    writeFileSync(
      path.join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        validation: { commands: ['echo ok'], timeout: 60 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 3 },
          implement: { maxIterations: 3 },
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
    const c = composeRoot({
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoRoot: root,
      scriptPath: '/dev/null',
      runStartupSweeps: false,
    });
    expect(c.runExecutor).toBeDefined();
    expect(c.phaseRegistry).toBeDefined();
    expect(c.runExecutor).toBeInstanceOf(RunExecutor);
    expect(c.phaseRegistry.get(PhaseName('read_issue'))).toBeDefined();
    expect(typeof c.phaseRegistry.get(PhaseName('read_issue'))!.run).toBe('function');

    // Verify handlers are real implementations, not HandlerNotWiredError stubs
    const readIssueHandler = c.phaseRegistry.get(PhaseName('read_issue'));
    expect(readIssueHandler).toBeDefined();
    expect(readIssueHandler).toBeInstanceOf(ReadIssueHandler);

    // Verify all 9 canonical phases have handlers registered and are real
    // implementations (not HandlerNotWiredError stubs)
    const handlerClasses: Record<string, unknown> = {
      read_issue: ReadIssueHandler,
      'plan-design': PlanDesignHandler,
      'plan-write': PlanWriteHandler,
      implement: ImplementHandler,
      validate: ValidateHandler,
      'review-fix': ReviewFixHandler,
      compound: CompoundHandler,
      'create-pr': CreatePrHandler,
      'post-pr-review': PostPrReviewHandler,
    };
    for (const [phase, HandlerClass] of Object.entries(handlerClasses)) {
      const handler = c.phaseRegistry.get(PhaseName(phase));
      expect(handler).toBeDefined();
      expect(handler).toBeInstanceOf(HandlerClass as new (...args: never[]) => object);
    }
  });

  it('read_issue handler does not throw HandlerNotWiredError', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    writeFileSync(
      path.join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        validation: { commands: ['echo ok'], timeout: 60 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 3 },
          implement: { maxIterations: 3 },
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
    const c = composeRoot({
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoRoot: root,
      scriptPath: '/dev/null',
      runStartupSweeps: false,
    });
    const handler = c.phaseRegistry.get(PhaseName('read_issue'));
    expect(handler).toBeDefined();
    // The handler should NOT be a HandlerNotWiredError stub
    expect(handler).toBeInstanceOf(ReadIssueHandler);
  });

  it('reviewFixLoop.execute converges when review immediately passes', async () => {
    const bus = {
      publish: (_runUuid: string, _event: OrchestratorEvent) => {},
      subscribe: () => () => {},
    };
    const fixLoop = new ReviewFixLoop({
      runPostFixGate: async (): Promise<PostFixGateResult> => ({
        outcome: 'pass',
        output: '',
      }),
      runReview: async () => ({
        invocationId: 'review-1',
        agentOutcome: 'success' as const,
        verdict: 'pass' as const,
      }),
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
      runRevalidation: async () => ({
        validationRunId: 'reval-1',
        passed: true,
      }),
      loops: new FakeLoopRepository(),
      events: bus,
      now: () => new Date(),
      idFactory: () => 'smoke-loop-1',
    });

    const result = await fixLoop.execute({
      runId: RunId('test-run'),
      phaseId: PhaseName('whole-pr-review'),
      repoId: 'owner/repo',
      cwd: '/tmp',
      maxIterations: 3,
      reviewProfile: AgentProfileName('test'),
      fixProfile: AgentProfileName('test'),
    });

    expect(result.phaseOutcome).toBe('passed');
    expect(result.loop.status).toBe('converged');
    expect(result.loop.iterations).toHaveLength(1);
  });

  it('ReviewFixLoop passes gate failure output to runReview on iteration 2', async () => {
    const bus = {
      publish: (_runUuid: string, _event: OrchestratorEvent) => {},
      subscribe: () => () => {},
    };
    const receivedGateResults: Array<PostFixGateResult | undefined> = [];
    let reviewCalls = 0;

    const fixLoop = new ReviewFixLoop({
      runPostFixGate: async (): Promise<PostFixGateResult> => ({
        outcome: 'fail',
        output: 'src/bar.ts(3,5): error TS2345: no-explicit-any violation',
      }),
      runReview: async (_ctx, opts) => {
        reviewCalls += 1;
        const gateResult = opts && 'gateResult' in opts ? opts.gateResult : opts;
        receivedGateResults.push(gateResult);
        return {
          invocationId: `review-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls < 3 ? ('fail' as const) : ('pass' as const),
        };
      },
      runFix: async () => ({
        invocationId: 'fix-1',
        agentOutcome: 'success' as const,
        verdict: 'done_with_fixes' as const,
      }),
      runRevalidation: async () => ({
        validationRunId: 'reval-1',
        passed: true,
      }),
      loops: new FakeLoopRepository(),
      events: bus,
      now: () => new Date(),
      idFactory: () => 'smoke-loop-gate',
    });

    const result = await fixLoop.execute({
      runId: RunId('test-run-gate'),
      phaseId: PhaseName('whole-pr-review'),
      repoId: 'owner/repo',
      cwd: '/tmp',
      maxIterations: 4,
      reviewProfile: AgentProfileName('test'),
      fixProfile: AgentProfileName('test'),
    });

    expect(result.phaseOutcome).toBe('passed');
    expect(receivedGateResults[0]).toBeUndefined();
    expect(receivedGateResults[1]).toEqual({
      outcome: 'fail',
      output: 'src/bar.ts(3,5): error TS2345: no-explicit-any violation',
    });
    expect(reviewCalls).toBe(3);
  });

  it('removes per-run tmp dir after a failed run completes', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(1);
    const origTmpdir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      const container = composeRoot({
        metadataResolver: FAKE_METADATA_RESOLVER,
        repoRoot: root,
        scriptPath,
      });
      const out = await container.startIssueRun.execute({
        issueNumber: 4,
        repoId: RepositoryId('owner/repo'),
      });
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
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoRoot: trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-'))),
      scriptPath: 'scripts/legacy/ai-run-issue-v2',
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
        metadataResolver: FAKE_METADATA_RESOLVER,
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
      metadataResolver: FAKE_METADATA_RESOLVER,
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

  it('exposes cancelRun use case', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const c = composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });
    expect(c.cancelRun).toBeDefined();
    expect(typeof c.cancelRun.execute).toBe('function');
  });

  it('exposes stepRepository backed by SQLite persistence', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const c = composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });

    const step: Step = {
      id: 'test-step-1',
      runId: 'test-run-uuid',
      phaseId: 'implement',
      index: 0,
      title: 'Test Step 1',
      status: 'success',
      startedAt: new Date('2026-06-01T00:00:00Z'),
      completedAt: new Date('2026-06-01T01:00:00Z'),
    };

    c.stepRepository.upsert(step);

    const steps = c.stepRepository.listForRun('test-run-uuid');
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe('test-step-1');
    expect(steps[0].runId).toBe('test-run-uuid');
    expect(steps[0].status).toBe('success');
    expect(steps[0].startedAt).toBeDefined();
    expect(steps[0].completedAt).toBeDefined();

    // Verify SQLite persistence by creating a second container with the same db
    const c2 = composeRoot({
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoRoot: root,
      scriptPath,
    });
    const steps2 = c2.stepRepository.listForRun('test-run-uuid');
    expect(steps2).toHaveLength(1);
    expect(steps2[0].id).toBe('test-step-1');
  });

  it('exposes resumeRun and retryFailedPhase use cases', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const c = composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });
    expect(c.resumeRun).toBeDefined();
    expect(typeof c.resumeRun.execute).toBe('function');
    expect(c.retryFailedPhase).toBeDefined();
    expect(typeof c.retryFailedPhase.execute).toBe('function');
  });

  it('cancelRun git dep is a GitWorktreeAdapter instance', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const c = composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((c.cancelRun as any).deps.git).toBeInstanceOf(GitWorktreeAdapter);
  });

  it('cancelRun cancels a running run in the DB', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const dbPath = path.join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, skipped_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'cancel-test-uuid',
      'issue-42-20260601-000000',
      42,
      'issue_to_pr',
      'running',
      '[]',
      '[]',
      new Date().toISOString(),
    );
    db.close();

    const c = composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });
    await c.cancelRun.execute({ runId: RunId('cancel-test-uuid'), reason: 'test cancellation' });
    const run = c.runRepository.findByUuid('cancel-test-uuid');
    expect(run?.status).toBe('cancelled');
    expect(run?.failureReason).toBe('test cancellation');
    expect(run?.currentPhase).toBeUndefined();
  });

  it('cancelRun findCwd resolves from displayId', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const dbPath = path.join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, skipped_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'findcwd-test-uuid',
      'issue-99-20260601-000000',
      99,
      'issue_to_pr',
      'running',
      '[]',
      '[]',
      new Date().toISOString(),
    );
    db.close();

    const c = composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cwd = (c.cancelRun as any).deps.findCwd('findcwd-test-uuid' as RunId);
    expect(cwd).toContain('issue-99');
  });

  it('cancelRun findStartCommitSha reads from run record', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const dbPath = path.join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, completed_phases, skipped_phases, started_at, start_commit_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'startsha-test-uuid',
      'issue-77-20260601-000000',
      77,
      'issue_to_pr',
      'running',
      '[]',
      '[]',
      new Date().toISOString(),
      'abc123def456',
    );
    db.close();

    const c = composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });
    const run = c.runRepository.findByUuid('startsha-test-uuid');
    expect(run?.startCommitSha).toBe('abc123def456');
  });

  it('exposes git adapter on the container', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    const scriptPath = fakeScript(0);
    const c = composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });
    expect(c.git).toBeInstanceOf(GitWorktreeAdapter);
  });

  it('exposes workerRegistry and workerLoopDeps on the container when agent config is present', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'compose-wreg-')));
    const dbPath = path.join(root, 'test.db');
    writeFileSync(
      path.join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        validation: { commands: ['echo ok'], timeout: 60 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 3, blockOnSeverity: 'medium' },
          implement: { maxIterations: 3 },
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
    const container = composeRoot({
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoRoot: root,
      scriptPath: '/dev/null',
      dbPath,
      repoFullName: 'owner/repo',
      runStartupSweeps: false,
    });
    expect(container.workerRegistry).toBeDefined();
    expect(container.workerLoopDeps).toBeDefined();
  });

  it('workerLoopDeps.prepareWorktree calls git.createWorktree and updates startCommitSha on the run record', async () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'compose-prepare-wt-')));
    writeFileSync(
      path.join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        validation: { commands: ['echo ok'], timeout: 60 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 3, blockOnSeverity: 'medium' },
          implement: { maxIterations: 3 },
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
    const container = composeRoot({
      metadataResolver: FAKE_METADATA_RESOLVER,
      repoRoot: root,
      scriptPath: '/dev/null',
      repoFullName: 'owner/repo',
      runStartupSweeps: false,
    });
    expect(container.workerLoopDeps).toBeDefined();

    // Seed a run row so prepareWorktree can find it via findByUuid
    container.runRepository.insertIfNoActive({
      uuid: 'prepare-wt-uuid',
      displayId: 'issue-71-20260622-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 71,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date(),
    });

    const createWorktreeSpy = vi
      .spyOn(GitWorktreeAdapter.prototype, 'createWorktree')
      .mockResolvedValue(undefined);
    vi.spyOn(GitWorktreeAdapter.prototype, 'seedArtifactExcludes').mockResolvedValue(undefined);
    const headCommitShaSpy = vi
      .spyOn(GitWorktreeAdapter.prototype, 'headCommitSha')
      .mockResolvedValue('feedfacefeedfacefeedfacefeedfacefeedface');

    const ac = new AbortController();
    const result = await container.workerLoopDeps!.prepareWorktree({
      repoId: RepositoryId('owner/repo'),
      runId: RunId('prepare-wt-uuid'),
      signal: ac.signal,
    });

    expect(createWorktreeSpy).toHaveBeenCalledOnce();
    expect(createWorktreeSpy.mock.calls[0][0]).toMatchObject({
      worktreePath: path.join(root, '.ai-worktrees', 'issue-71'),
      branch: 'ai/issue-71',
    });
    expect(headCommitShaSpy).toHaveBeenCalledOnce();

    const updated = container.runRepository.findByUuid('prepare-wt-uuid');
    expect(updated?.startCommitSha).toBe('feedfacefeedfacefeedfacefeedfacefeedface');
    expect(result.cwd).toBe(path.join(root, '.ai-worktrees', 'issue-71'));

    createWorktreeSpy.mockRestore();
    headCommitShaSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('buildRunContext populates promptsRoot and expectedBranch from repoRoot and issueNumber', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
    writeFileSync(
      path.join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        validation: { commands: ['echo ok'], timeout: 60 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 3, blockOnSeverity: 'medium' },
          implement: { maxIterations: 3 },
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
    const scriptPath = fakeScript(0);
    const c = composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });
    // buildRunContext is only present when agent config loaded
    expect(c.buildRunContext).toBeDefined();
    const fakeRun = {
      uuid: '550e8400-e29b-41d4-a716-446655440042',
      displayId: 'issue-42-20260622-120000',
      issueNumber: 42,
      type: 'issue_to_pr' as const,
      status: 'running' as const,
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date(),
    };
    const ctx = c.buildRunContext!(fakeRun);
    expect(ctx.promptsRoot).toBe(path.join(root, 'prompts'));
    expect(ctx.expectedBranch).toBe('ai/issue-42');
    expect(ctx.cwd).toBe(path.join(root, '.ai-worktrees', 'issue-42'));
  });

  it('buildRunContext is undefined when agent config is absent', () => {
    const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-noagent-')));
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const scriptPath = fakeScript(0);
    const c = composeRoot({ metadataResolver: FAKE_METADATA_RESOLVER, repoRoot: root, scriptPath });
    expect(c.buildRunContext).toBeUndefined();
  });

  it('runTypecheck contains non-fatal pre-build step before typecheck', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );
    const typecheckFnMatch = composeSrc.match(/const runTypecheck[\s\S]*?(?=const runSpecReview)/);
    expect(typecheckFnMatch).toBeTruthy();
    const fnSrc = typecheckFnMatch![0];
    const buildIdx = fnSrc.indexOf("'-r', 'build'");
    const typecheckIdx = fnSrc.indexOf("'-r', 'typecheck'");
    expect(buildIdx).toBeGreaterThan(-1);
    expect(typecheckIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(typecheckIdx);
    expect(fnSrc).toContain('timeout: 180_000');
    expect(fnSrc).toContain('let buildError');
    expect(fnSrc).toContain('buildError = captureExecOutput(err)');
    expect(fnSrc).toContain('if (buildError)');
    expect(fnSrc).toMatch(/catch[^{]*\{[^}]*\/\/ Non-fatal/);
  });

  it('runPostFixGate contains non-fatal pre-build step before typecheck', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );
    const gateFnMatch = composeSrc.match(
      /const runPostFixGate[\s\S]*?(?=const reviewFixLoopInstance)/,
    );
    expect(gateFnMatch).toBeTruthy();
    const fnSrc = gateFnMatch![0];
    const buildIdx = fnSrc.indexOf("'-r', 'build'");
    const typecheckIdx = fnSrc.indexOf("'-r', 'typecheck'");
    expect(buildIdx).toBeGreaterThan(-1);
    expect(typecheckIdx).toBeGreaterThan(-1);
    expect(buildIdx).toBeLessThan(typecheckIdx);
    expect(fnSrc).toContain('timeout: 180_000');
    expect(fnSrc).toContain('let buildError');
    expect(fnSrc).toContain('buildError = captureExecOutput(err)');
    expect(fnSrc).toMatch(/catch[^{]*\{[^}]*\/\/ Non-fatal/);
  });

  it('archives phase-segregated review/fix results so runArbiter reads distinct excerpts (#661)', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );
    // runSpecReview must archive its result.json under a spec-review-specific name
    const specReviewMatch = composeSrc.match(
      /const runSpecReview[\s\S]*?(?=const runQualityReview)/,
    );
    expect(specReviewMatch).toBeTruthy();
    expect(specReviewMatch![0]).toContain('SPEC_REVIEW_RESULT_ARTIFACT');
    // runQualityReview must archive its result.json under a quality-review-specific name
    const qualityReviewMatch = composeSrc.match(
      /const runQualityReview[\s\S]*?(?=const implRunFix)/,
    );
    expect(qualityReviewMatch).toBeTruthy();
    expect(qualityReviewMatch![0]).toContain('QUALITY_REVIEW_RESULT_ARTIFACT');
    // implRunFix must archive its result.json under a fix-specific name
    const fixMatch = composeSrc.match(/const implRunFix[\s\S]*?(?=type LoopArbiterResult)/);
    expect(fixMatch).toBeTruthy();
    expect(fixMatch![0]).toContain('FIX_RESULT_ARTIFACT');
    // runArbiter must read the segregated artifacts, never the shared result.json
    // (both excerpts previously read the same path, so the arbiter always saw
    // identical spec and fix content)
    const arbiterMatch = composeSrc.match(
      /const runArbiter[\s\S]*?(?=implementStepLoop = new ImplementStepLoop)/,
    );
    expect(arbiterMatch).toBeTruthy();
    expect(arbiterMatch![0]).toContain('readArbiterExcerpts');
    expect(arbiterMatch![0]).not.toMatch(/artifacts\.read\(String\(ctx\.runId\), 'result\.json'\)/);
  });

  it('implRunFix forwards FixStepOptions.reconciliationContext and historyContext into buildImplementStepFixPrompt (#670)', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );
    const fixMatch = composeSrc.match(/const implRunFix[\s\S]*?(?=type LoopArbiterResult)/);
    expect(fixMatch).toBeTruthy();
    // The call site must spread opts.reconciliationContext and opts.historyContext
    // into the prompt-builder input object. Without this, the arbiter rationale
    // and prior-fix-history are silently dropped (issue #670).
    expect(fixMatch![0]).toMatch(/buildImplementStepFixPrompt\([^;]*?reconciliationContext/);
    expect(fixMatch![0]).toMatch(/buildImplementStepFixPrompt\([^;]*?historyContext/);
  });

  describe('worktreeSetup behavior', () => {
    const fakeAgentConfig = {
      validation: { commands: ['echo ok'], timeout: 60 },
      phases: {
        skip: [],
        reviewFix: { maxIterations: 3 },
        implement: { maxIterations: 3 },
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
    };

    it('runs pnpm install and pnpm -r build when feature branch has no WIP commits', async () => {
      const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
      writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(fakeAgentConfig));
      const scriptPath = fakeScript(0);
      const container = composeRoot({
        metadataResolver: FAKE_METADATA_RESOLVER,
        repoRoot: root,
        scriptPath,
      });

      const implementHandler = container.phaseRegistry.get(PhaseName('implement')) as unknown as {
        opts: {
          setup: (cwd: string) => Promise<{ ok: boolean; error?: string }>;
        };
      };
      const setup = implementHandler.opts.setup;
      expect(setup).toBeDefined();

      const logBetweenSpy = vi
        .spyOn(GitWorktreeAdapter.prototype, 'logBetween')
        .mockResolvedValue([]);
      const execSpy = vi.mocked(childProcess.execFileSync);
      execSpy.mockImplementation(() => '');

      const res = await setup('/some/cwd');
      expect(res).toEqual({ ok: true });

      // pnpm install always runs
      expect(execSpy).toHaveBeenCalledWith(
        'pnpm',
        ['install', '--frozen-lockfile'],
        expect.any(Object),
      );
      // pnpm -r build runs because there are no WIP commits
      expect(execSpy).toHaveBeenCalledWith('pnpm', ['-r', 'build'], expect.any(Object));

      logBetweenSpy.mockRestore();
      execSpy.mockRestore();
    });

    it('runs pnpm install but skips pnpm -r build when feature branch has WIP commits', async () => {
      const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
      writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(fakeAgentConfig));
      const scriptPath = fakeScript(0);
      const container = composeRoot({
        metadataResolver: FAKE_METADATA_RESOLVER,
        repoRoot: root,
        scriptPath,
      });

      const implementHandler = container.phaseRegistry.get(PhaseName('implement')) as unknown as {
        opts: {
          setup: (cwd: string) => Promise<{ ok: boolean; error?: string }>;
        };
      };
      const setup = implementHandler.opts.setup;
      expect(setup).toBeDefined();

      const logBetweenSpy = vi
        .spyOn(GitWorktreeAdapter.prototype, 'logBetween')
        .mockResolvedValue(['wip']);
      const execSpy = vi.mocked(childProcess.execFileSync);
      execSpy.mockImplementation(() => '');

      const res = await setup('/some/cwd');
      expect(res).toEqual({ ok: true });

      // pnpm install always runs
      expect(execSpy).toHaveBeenCalledWith(
        'pnpm',
        ['install', '--frozen-lockfile'],
        expect.any(Object),
      );
      // pnpm -r build is skipped because logBetween returned a commit
      expect(execSpy).not.toHaveBeenCalledWith('pnpm', ['-r', 'build'], expect.any(Object));

      logBetweenSpy.mockRestore();
      execSpy.mockRestore();
    });

    it('falls back to a fresh build (and logs a warning) when logBetween throws', async () => {
      const root = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-compose-')));
      writeFileSync(path.join(root, '.ai-orchestrator.json'), JSON.stringify(fakeAgentConfig));
      const scriptPath = fakeScript(0);
      const container = composeRoot({
        metadataResolver: FAKE_METADATA_RESOLVER,
        repoRoot: root,
        scriptPath,
      });

      const implementHandler = container.phaseRegistry.get(PhaseName('implement')) as unknown as {
        opts: {
          setup: (cwd: string) => Promise<{ ok: boolean; error?: string }>;
        };
      };
      const setup = implementHandler.opts.setup;
      expect(setup).toBeDefined();

      const logBetweenSpy = vi
        .spyOn(GitWorktreeAdapter.prototype, 'logBetween')
        .mockRejectedValue(new Error('fatal git error: broken repo'));
      const execSpy = vi.mocked(childProcess.execFileSync);
      execSpy.mockImplementation(() => '');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const res = await setup('/some/cwd');
      expect(res).toEqual({ ok: true });

      // pnpm install always runs
      expect(execSpy).toHaveBeenCalledWith(
        'pnpm',
        ['install', '--frozen-lockfile'],
        expect.any(Object),
      );
      // pnpm -r build ALSO runs because logBetween threw — hasWip defaults to false
      expect(execSpy).toHaveBeenCalledWith('pnpm', ['-r', 'build'], expect.any(Object));
      // The swallowed error is logged at warn level so operators can diagnose
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[implement setup] logBetween failed'),
      );
      expect(warnSpy.mock.calls[0]?.[0]).toContain('fatal git error: broken repo');

      logBetweenSpy.mockRestore();
      execSpy.mockRestore();
      warnSpy.mockRestore();
    });
  });

  describe('captureExecOutput', () => {
    it('returns stdout+stderr from execFileSync error with both streams', () => {
      const err = new Error('Command failed') as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
      };
      err.stdout = 'stdout output\n';
      err.stderr = 'stderr output\n';
      expect(captureExecOutput(err)).toBe('stdout output\n\nstderr output\n');
    });

    it('returns stderr when stdout is empty', () => {
      const err = new Error('Command failed') as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
      };
      err.stdout = '';
      err.stderr = 'stderr only\n';
      expect(captureExecOutput(err)).toBe('stderr only\n');
    });

    it('returns stdout when stderr is empty', () => {
      const err = new Error('Command failed') as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
      };
      err.stdout = 'stdout only\n';
      err.stderr = '';
      expect(captureExecOutput(err)).toBe('stdout only\n');
    });

    it('adds newline separator when stdout lacks trailing newline', () => {
      const err = new Error('Command failed') as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
      };
      err.stdout = 'error TS2322';
      err.stderr = 'error TS2345\n';
      expect(captureExecOutput(err)).toBe('error TS2322\nerror TS2345\n');
    });

    it('returns String(err) for non-execFileSync errors', () => {
      const err = new Error('generic error');
      expect(captureExecOutput(err)).toBe('Error: generic error');
    });
  });

  describe('targetRepoRoot', () => {
    it('derives runsDir from targetRepoRoot when set', () => {
      const repoRoot = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-target-')));
      const target = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-target-other-')));
      const scriptPath = fakeScript(0);
      const container = composeRoot({
        metadataResolver: FAKE_METADATA_RESOLVER,
        repoRoot,
        scriptPath,
        targetRepoRoot: target,
      });
      expect(container.runsDir).toBe(path.join(target, '.ai-runs'));
    });

    it('falls back to repoRoot when targetRepoRoot is unset', () => {
      const repoRoot = trackDir(() => mkdtempSync(path.join(os.tmpdir(), 'ai-orch-target-fb-')));
      const scriptPath = fakeScript(0);
      const container = composeRoot({
        metadataResolver: FAKE_METADATA_RESOLVER,
        repoRoot,
        scriptPath,
      });
      expect(container.runsDir).toBe(path.join(repoRoot, '.ai-runs'));
    });
  });

  it('implement-step fix prompt no longer tells fixer to read a nonexistent findings file (#664)', () => {
    // Source-level regression check: the old broken contract must be gone,
    // and the new findings section must be present.
    const fs = require('node:fs');
    const path = require('node:path');
    const composeSource = fs.readFileSync(path.join(__dirname, '..', 'compose.ts'), 'utf-8');
    expect(composeSource).not.toContain('Read any review findings in the working directory');
    expect(composeSource).toContain('## WHAT THE REVIEWERS FOUND (verbatim)');
  });
});
