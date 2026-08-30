import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram as originalBuildProgram } from '../cli.js';
import {
  openDatabase,
  applyMigrations,
  RunRepository,
  PhaseRepository,
  WorkerLeaseRepository,
  JobQueueRepository,
  GitWorktreeAdapter,
} from '@ai-sdlc/infrastructure';
import { RunExecutor, ResumeRun } from '@ai-sdlc/application';
import { WorkerScheduler } from '../worker-scheduler.js';
import { createRun, RepositoryId, PhaseName, type PhaseId } from '@ai-sdlc/domain';
import { EXIT_USER_ERROR } from '../cli/exit-codes.js';

function buildProgram(opts?: Parameters<typeof originalBuildProgram>[0]) {
  return originalBuildProgram({
    isCliTestSuite: true,
    bypassPlanValidation: true,
    ...opts,
  });
}

describe('CLI execution policy and observability (#1122)', () => {
  const tempDirs: string[] = [];
  let consoleErrorSpy: ReturnType<typeof vi.spyOn<typeof console, 'error'>>;
  let exitSpy: ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(GitWorktreeAdapter.prototype, 'seedArtifactExcludes').mockResolvedValue(undefined);
    vi.spyOn(GitWorktreeAdapter.prototype, 'remoteRef').mockResolvedValue('mock-sha');
    vi.spyOn(WorkerLeaseRepository.prototype, 'release').mockImplementation(() => {});
    vi.spyOn(WorkerLeaseRepository.prototype, 'heartbeat').mockImplementation(() => {});
    vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockResolvedValue(undefined);
    vi.spyOn(JobQueueRepository.prototype, 'findById').mockReturnValue({
      id: 'mock-job-id',
      repoId: 'test-owner/test-repo',
      status: 'succeeded',
      priority: 0,
      attempts: 0,
      createdAt: new Date(),
    } as never);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  });

  function trackDir<T>(fn: () => T): T {
    const result = fn();
    tempDirs.push(result as unknown as string);
    return result;
  }

  function setupTempRepo(opts: { defaultPolicy?: string } = {}) {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cli-policy-')));
    execSync('git init -b main', { cwd: root });
    execSync('git config user.name "Test"', { cwd: root });
    execSync('git config user.email "test@example.com"', { cwd: root });
    execSync('git remote add origin https://github.com/test-owner/test-repo.git', { cwd: root });
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    writeFileSync(
      join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        executionPolicy: opts.defaultPolicy ?? 'standard',
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
            test: {
              runtime: 'opencode',
              provider: 'test',
              model: 'test',
              timeoutMinutes: 1,
            },
          },
          phaseProfiles: {
            'whole-pr-review': { profile: 'test' },
            'fix-review': { profile: 'test' },
          },
        },
      }),
    );
    mkdirSync(join(root, '.ai-runs'), { recursive: true });
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT OR REPLACE INTO repositories (id, full_name, owner, name, local_base_path, default_branch, remote_url, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'test-owner/test-repo',
      'test-owner/test-repo',
      'test-owner',
      'test-repo',
      root,
      'main',
      'https://github.com/test-owner/test-repo',
      1,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.close();
    process.chdir(root);
    return { root, dbPath };
  }

  const getComposeOverrides = (root: string) => ({
    repoFullName: 'test-owner/test-repo',
    repoRoot: root,
    metadataResolver: {
      resolve: () => ({
        rootPath: root,
        nameWithOwner: 'test-owner/test-repo',
        defaultBranch: 'main',
        remoteUrl: 'https://github.com/test-owner/test-repo',
      }),
    },
  });

  it('sets executionPolicy=strict and prints phase graph when --strict is passed', async () => {
    const { root, dbPath } = setupTempRepo({ defaultPolicy: 'standard' });

    vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
      run: {
        uuid: 'test-run-uuid',
        status: 'passed',
        displayId: '1122-1',
        issueNumber: 1122,
        type: 'issue_to_pr',
        completedPhases: ['read_issue'],
        skippedPhases: [],
        startedAt: new Date(),
      },
      phases: [],
    });

    const program = buildProgram({
      composeOverrides: getComposeOverrides(root),
    });
    await program.parseAsync([
      'node',
      'cli.ts',
      'run',
      '--issue',
      '1122',
      '--strict',
      '--target-repo-root',
      root,
      '--repository-id',
      'test-owner/test-repo',
    ]);

    const db = openDatabase(dbPath);
    const runRepo = new RunRepository(db);
    const { runs } = runRepo.list();
    db.close();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.executionPolicy).toBe('strict');

    const errCalls = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errCalls).toContain('Execution policy: STRICT');
    expect(errCalls).toContain('Phase graph:');
    expect(errCalls).toContain('architecture-review');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('sets executionPolicy=standard and prints phase graph without architecture-review', async () => {
    const { root, dbPath } = setupTempRepo({ defaultPolicy: 'strict' });

    vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
      run: {
        uuid: 'test-run-uuid',
        status: 'passed',
        displayId: '1122-1',
        issueNumber: 1122,
        type: 'issue_to_pr',
        completedPhases: ['read_issue'],
        skippedPhases: [],
        startedAt: new Date(),
      },
      phases: [],
    });

    const program = buildProgram({
      composeOverrides: getComposeOverrides(root),
    });
    await program.parseAsync([
      'node',
      'cli.ts',
      'run',
      '--issue',
      '1122',
      '--execution-policy',
      'standard',
      '--target-repo-root',
      root,
      '--repository-id',
      'test-owner/test-repo',
    ]);

    const db = openDatabase(dbPath);
    const runRepo = new RunRepository(db);
    const { runs } = runRepo.list();
    db.close();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.executionPolicy).toBe('standard');

    const errCalls = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errCalls).toContain('Execution policy: STANDARD');
    expect(errCalls).toContain('Phase graph:');
    expect(errCalls).not.toContain('architecture-review');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('rejects conflicting --strict and --execution-policy standard with error', async () => {
    const { root } = setupTempRepo();

    const program = buildProgram({
      composeOverrides: getComposeOverrides(root),
    });
    await program.parseAsync([
      'node',
      'cli.ts',
      'run',
      '--issue',
      '1122',
      '--strict',
      '--execution-policy',
      'standard',
      '--target-repo-root',
      root,
      '--repository-id',
      'test-owner/test-repo',
    ]);

    expect(exitSpy).toHaveBeenCalledWith(EXIT_USER_ERROR);
    const errCalls = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errCalls).toContain('conflicting options --strict and --execution-policy standard');
  });

  it('rejects invalid --execution-policy value with error', async () => {
    const { root } = setupTempRepo();

    const program = buildProgram({
      composeOverrides: getComposeOverrides(root),
    });
    await program.parseAsync([
      'node',
      'cli.ts',
      'run',
      '--issue',
      '1122',
      '--execution-policy',
      'turbo',
      '--target-repo-root',
      root,
      '--repository-id',
      'test-owner/test-repo',
    ]);

    expect(exitSpy).toHaveBeenCalledWith(EXIT_USER_ERROR);
    const errCalls = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errCalls).toContain('--execution-policy must be "legacy", "standard", or "strict"');
  });

  it('runs resume inherits persisted executionPolicy and logs phase graph', async () => {
    const { root, dbPath } = setupTempRepo();

    const db = openDatabase(dbPath);
    const runRepo = new RunRepository(db);
    const phaseRepo = new PhaseRepository(db);

    const testRun = createRun({
      uuid: 'test-strict-uuid-1122',
      displayId: '1122-1',
      repoId: RepositoryId('test-owner/test-repo'),
      issueNumber: 1122,
      startedAt: new Date(),
      executionPolicy: 'strict',
    });
    testRun.status = 'needs_human_review';
    testRun.currentPhase = PhaseName('architecture-review');
    runRepo.insertIfNoActive(testRun);

    phaseRepo.insert({
      id: 'p-1' as PhaseId,
      runUuid: 'test-strict-uuid-1122',
      name: PhaseName('read_issue'),
      attempt: 1,
      status: 'passed',
      startedAt: new Date(),
      completedAt: new Date(),
    });
    phaseRepo.insert({
      id: 'p-2' as PhaseId,
      runUuid: 'test-strict-uuid-1122',
      name: PhaseName('plan-design'),
      attempt: 1,
      status: 'passed',
      startedAt: new Date(),
      completedAt: new Date(),
    });
    phaseRepo.insert({
      id: 'p-3' as PhaseId,
      runUuid: 'test-strict-uuid-1122',
      name: PhaseName('architecture-review'),
      attempt: 1,
      status: 'failed',
      startedAt: new Date(),
      completedAt: new Date(),
    });
    db.close();

    vi.spyOn(ResumeRun.prototype, 'transition').mockResolvedValue({
      savedStatus: 'needs_human_review',
      savedCompletedAt: null,
      savedFailureReason: null,
      savedCurrentPhase: PhaseName('architecture-review'),
      savedCompletedPhases: ['read_issue', 'plan-design'],
      savedSkippedPhases: [],
      savedSteps: [],
      effectiveDisposition: 'keep_artifacts_resume_in_place',
    });

    vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
      run: {
        uuid: 'test-strict-uuid-1122',
        status: 'passed',
        displayId: '1122-1',
        issueNumber: 1122,
        type: 'issue_to_pr',
        completedPhases: ['read_issue', 'plan-design', 'architecture-review'],
        skippedPhases: [],
        startedAt: new Date(),
      },
      phases: [],
    });

    const program = buildProgram({
      composeOverrides: getComposeOverrides(root),
    });
    await program.parseAsync([
      'node',
      'cli.ts',
      'runs',
      'resume',
      '--uuid',
      'test-strict-uuid-1122',
      '--target-repo-root',
      root,
      '--repository-id',
      'test-owner/test-repo',
    ]);

    const errCalls = consoleErrorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errCalls).toContain('Execution policy: STRICT');
    expect(errCalls).toContain('Resuming from phase: architecture-review');
    expect(errCalls).toContain('Phase graph:');
    expect(errCalls).toContain('architecture-review');
  });
});
