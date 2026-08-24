import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../cli.js';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';
import { RunExecutor, ResumeRun, RetryFailedPhase } from '@ai-sdlc/application';
import { WorkerLeaseRepository } from '@ai-sdlc/infrastructure';
import { WorkerId, RepositoryId, RunId, LeaseToken } from '@ai-sdlc/domain';

describe('CLI runs resume confirmation tests', () => {
  const tempDirs: string[] = [];
  let consoleErrorSpy: ReturnType<typeof vi.spyOn<typeof console, 'error'>>;
  let exitSpy: ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;

  beforeEach(() => {
    // Spying process.exit to throw so that the CLI execution stops immediately
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit: ${code}`);
    });
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(WorkerLeaseRepository.prototype, 'release').mockImplementation(() => {});
    vi.spyOn(WorkerLeaseRepository.prototype, 'heartbeat').mockImplementation(() => {});
  });

  afterEach(() => {
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

  function setupTempRepo(uuid: string, currentPhase: string, status: string = 'failed') {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cli-confirm-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    writeFileSync(
      join(root, '.ai-orchestrator.json'),
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

    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);

    db.prepare(
      `INSERT OR REPLACE INTO repositories (id, full_name, owner, name, local_base_path, default_branch, remote_url, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'owner/repo',
      'owner/repo',
      'owner',
      'repo',
      root,
      'main',
      'https://github.com/owner/repo',
      1,
      new Date().toISOString(),
      new Date().toISOString(),
    );

    db.prepare(
      `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, current_phase, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuid,
      'issue-123-20260622-000000',
      'owner/repo',
      123,
      'issue_to_pr',
      status,
      currentPhase,
      '[]',
      new Date().toISOString(),
    );

    db.prepare(
      `INSERT INTO phases (id, run_uuid, name, status, attempt) VALUES (?, ?, ?, ?, ?)`,
    ).run(`${uuid}-${currentPhase}-1`, uuid, currentPhase, status, 1);

    db.close();
    return root;
  }

  it('rejects unsafe default retry without --confirm', async () => {
    const uuid = 'unsafe-default-retry-uuid';
    const root = setupTempRepo(uuid, 'create-pr', 'failed');

    const acquireSpy = vi
      .spyOn(WorkerLeaseRepository.prototype, 'acquire')
      .mockImplementation(() => {
        return {
          repoId: RepositoryId('owner/repo'),
          workerId: WorkerId(`cli-${process.pid}`),
          runId: RunId(uuid),
          acquiredAt: new Date(),
          heartbeatAt: new Date(),
          expiresAt: new Date(Date.now() + 120_000),
          leaseToken: 'mocked-token' as LeaseToken,
        };
      });

    const retrySpy = vi.spyOn(RetryFailedPhase.prototype, 'execute').mockResolvedValue(undefined);
    const transitionSpy = vi.spyOn(ResumeRun.prototype, 'transition').mockResolvedValue({
      savedStatus: 'failed',
      savedCompletedAt: null,
      savedFailureReason: null,
      savedCurrentPhase: null,
      savedCompletedPhases: [],
      savedSkippedPhases: [],
      savedSteps: [],
      effectiveDisposition: 'reset_to_baseline',
    });
    const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
      run: {
        uuid,
        status: 'passed' as const,
        displayId: 'issue-123-20260622-000000',
        issueNumber: 123,
        type: 'issue_to_pr' as const,
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      },
      phases: [],
    });

    const savedCwd = process.cwd();
    process.chdir(root);

    try {
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await expect(
        runsCmd.parseAsync(['resume', '--uuid', uuid], { from: 'user' }),
      ).rejects.toThrow(/process.exit: 1/);

      // Expect exit status 1
      expect(exitSpy).toHaveBeenCalledWith(1);

      // Expect stderr to mention confirmation
      const errMsgs = consoleErrorSpy.mock.calls.map((c) => c[0]).join(' ');
      expect(errMsgs).toMatch(/confirm|confirmation/i);

      // Expect no calls to lease acquisition, retry, transition, or executor
      expect(acquireSpy).not.toHaveBeenCalled();
      expect(retrySpy).not.toHaveBeenCalled();
      expect(transitionSpy).not.toHaveBeenCalled();
      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('rejects unsafe --from-phase implement without --confirm', async () => {
    const uuid = 'unsafe-from-phase-implement-uuid';
    const root = setupTempRepo(uuid, 'implement', 'failed');

    const acquireSpy = vi
      .spyOn(WorkerLeaseRepository.prototype, 'acquire')
      .mockImplementation(() => {
        return {
          repoId: RepositoryId('owner/repo'),
          workerId: WorkerId(`cli-${process.pid}`),
          runId: RunId(uuid),
          acquiredAt: new Date(),
          heartbeatAt: new Date(),
          expiresAt: new Date(Date.now() + 120_000),
          leaseToken: 'mocked-token' as LeaseToken,
        };
      });

    const retrySpy = vi.spyOn(RetryFailedPhase.prototype, 'execute').mockResolvedValue(undefined);
    const transitionSpy = vi.spyOn(ResumeRun.prototype, 'transition').mockResolvedValue({
      savedStatus: 'failed',
      savedCompletedAt: null,
      savedFailureReason: null,
      savedCurrentPhase: null,
      savedCompletedPhases: [],
      savedSkippedPhases: [],
      savedSteps: [],
      effectiveDisposition: 'reset_to_baseline',
    });
    const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
      run: {
        uuid,
        status: 'passed' as const,
        displayId: 'issue-123-20260622-000000',
        issueNumber: 123,
        type: 'issue_to_pr' as const,
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      },
      phases: [],
    });

    const savedCwd = process.cwd();
    process.chdir(root);

    try {
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await expect(
        runsCmd.parseAsync(['resume', '--uuid', uuid, '--from-phase', 'implement'], {
          from: 'user',
        }),
      ).rejects.toThrow(/process.exit: 1/);

      expect(exitSpy).toHaveBeenCalledWith(1);

      const errMsgs = consoleErrorSpy.mock.calls.map((c) => c[0]).join(' ');
      expect(errMsgs).toMatch(/confirm|confirmation/i);

      expect(acquireSpy).not.toHaveBeenCalled();
      expect(retrySpy).not.toHaveBeenCalled();
      expect(transitionSpy).not.toHaveBeenCalled();
      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('allows unsafe default retry with --confirm', async () => {
    const uuid = 'unsafe-default-retry-confirm-uuid';
    const root = setupTempRepo(uuid, 'create-pr', 'failed');

    const acquireSpy = vi
      .spyOn(WorkerLeaseRepository.prototype, 'acquire')
      .mockImplementation(() => {
        return {
          repoId: RepositoryId('owner/repo'),
          workerId: WorkerId(`cli-${process.pid}`),
          runId: RunId(uuid),
          acquiredAt: new Date(),
          heartbeatAt: new Date(),
          expiresAt: new Date(Date.now() + 120_000),
          leaseToken: 'mocked-token' as LeaseToken,
        };
      });

    const retrySpy = vi.spyOn(RetryFailedPhase.prototype, 'execute').mockResolvedValue(undefined);
    const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
      run: {
        uuid,
        status: 'passed' as const,
        displayId: 'issue-123-20260622-000000',
        issueNumber: 123,
        type: 'issue_to_pr' as const,
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      },
      phases: [],
    });

    const savedCwd = process.cwd();
    process.chdir(root);

    try {
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await expect(
        runsCmd.parseAsync(['resume', '--uuid', uuid, '--confirm'], { from: 'user' }),
      ).rejects.toThrow(/process.exit: 0/);

      expect(acquireSpy).toHaveBeenCalled();
      expect(retrySpy).toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalled();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('allows blocked runs to resume without --confirm when the target phase is safe', async () => {
    const uuid = 'blocked-default-resume-uuid';
    const root = setupTempRepo(uuid, 'validate', 'blocked');

    const acquireSpy = vi
      .spyOn(WorkerLeaseRepository.prototype, 'acquire')
      .mockImplementation(() => {
        return {
          repoId: RepositoryId('owner/repo'),
          workerId: WorkerId(`cli-${process.pid}`),
          runId: RunId(uuid),
          acquiredAt: new Date(),
          heartbeatAt: new Date(),
          expiresAt: new Date(Date.now() + 120_000),
          leaseToken: 'mocked-token' as LeaseToken,
        };
      });

    const retrySpy = vi.spyOn(RetryFailedPhase.prototype, 'execute').mockResolvedValue(undefined);
    const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
      run: {
        uuid,
        status: 'passed' as const,
        displayId: 'issue-123-20260622-000000',
        issueNumber: 123,
        type: 'issue_to_pr' as const,
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      },
      phases: [],
    });

    const savedCwd = process.cwd();
    process.chdir(root);

    try {
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await expect(
        runsCmd.parseAsync(['resume', '--uuid', uuid], { from: 'user' }),
      ).rejects.toThrow(/process.exit: 0/);

      expect(acquireSpy).toHaveBeenCalled();
      expect(retrySpy).toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalled();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('allows safe resume without --confirm', async () => {
    const uuid = 'safe-resume-validate-uuid';
    const root = setupTempRepo(uuid, 'validate', 'failed');

    const acquireSpy = vi
      .spyOn(WorkerLeaseRepository.prototype, 'acquire')
      .mockImplementation(() => {
        return {
          repoId: RepositoryId('owner/repo'),
          workerId: WorkerId(`cli-${process.pid}`),
          runId: RunId(uuid),
          acquiredAt: new Date(),
          heartbeatAt: new Date(),
          expiresAt: new Date(Date.now() + 120_000),
          leaseToken: 'mocked-token' as LeaseToken,
        };
      });

    const transitionSpy = vi.spyOn(ResumeRun.prototype, 'transition').mockResolvedValue({
      savedStatus: 'failed',
      savedCompletedAt: null,
      savedFailureReason: null,
      savedCurrentPhase: null,
      savedCompletedPhases: [],
      savedSkippedPhases: [],
      savedSteps: [],
      effectiveDisposition: 'reset_to_baseline',
    });
    const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
      run: {
        uuid,
        status: 'passed' as const,
        displayId: 'issue-123-20260622-000000',
        issueNumber: 123,
        type: 'issue_to_pr' as const,
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      },
      phases: [],
    });

    const savedCwd = process.cwd();
    process.chdir(root);

    try {
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await expect(
        runsCmd.parseAsync(['resume', '--uuid', uuid, '--from-phase', 'validate'], {
          from: 'user',
        }),
      ).rejects.toThrow(/process.exit: 0/);

      expect(acquireSpy).toHaveBeenCalled();
      expect(transitionSpy).toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeDisposition: 'reset_to_baseline',
        }),
      );
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('rejects invalid --disposition with exit 1', async () => {
    const uuid = 'invalid-disposition-uuid';
    const root = setupTempRepo(uuid, 'validate', 'failed');

    const savedCwd = process.cwd();
    process.chdir(root);

    try {
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await expect(
        runsCmd.parseAsync(
          ['resume', '--uuid', uuid, '--from-phase', 'validate', '--disposition', 'invalid_val'],
          { from: 'user' },
        ),
      ).rejects.toThrow(/process.exit: 1/);

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errMsgs = consoleErrorSpy.mock.calls.map((c) => c[0]).join(' ');
      expect(errMsgs).toMatch(/invalid --disposition/i);
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('passes explicit --disposition preserve_working_tree to transition and executor', async () => {
    const uuid = 'preserve-disposition-uuid';
    const root = setupTempRepo(uuid, 'validate', 'failed');

    vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockImplementation(() => ({
      repoId: RepositoryId('owner/repo'),
      workerId: WorkerId(`cli-${process.pid}`),
      runId: RunId(uuid),
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 120_000),
      leaseToken: 'mocked-token' as LeaseToken,
    }));

    const transitionSpy = vi.spyOn(ResumeRun.prototype, 'transition').mockResolvedValue({
      savedStatus: 'failed',
      savedCompletedAt: null,
      savedFailureReason: null,
      savedCurrentPhase: null,
      savedCompletedPhases: [],
      savedSkippedPhases: [],
      savedSteps: [],
      effectiveDisposition: 'preserve_working_tree',
    });
    const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
      run: {
        uuid,
        status: 'passed' as const,
        displayId: 'issue-123-20260622-000000',
        issueNumber: 123,
        type: 'issue_to_pr' as const,
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      },
      phases: [],
    });

    const savedCwd = process.cwd();
    process.chdir(root);

    try {
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await expect(
        runsCmd.parseAsync(
          [
            'resume',
            '--uuid',
            uuid,
            '--from-phase',
            'validate',
            '--disposition',
            'preserve_working_tree',
          ],
          { from: 'user' },
        ),
      ).rejects.toThrow(/process.exit: 0/);

      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeDisposition: 'preserve_working_tree',
        }),
      );
      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeDisposition: 'preserve_working_tree',
        }),
      );
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('passes explicit --disposition reset_to_baseline to transition and executor', async () => {
    const uuid = 'reset-disposition-uuid';
    const root = setupTempRepo(uuid, 'validate', 'failed');

    vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockImplementation(() => ({
      repoId: RepositoryId('owner/repo'),
      workerId: WorkerId(`cli-${process.pid}`),
      runId: RunId(uuid),
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 120_000),
      leaseToken: 'mocked-token' as LeaseToken,
    }));

    const transitionSpy = vi.spyOn(ResumeRun.prototype, 'transition').mockResolvedValue({
      savedStatus: 'failed',
      savedCompletedAt: null,
      savedFailureReason: null,
      savedCurrentPhase: null,
      savedCompletedPhases: [],
      savedSkippedPhases: [],
      savedSteps: [],
      effectiveDisposition: 'reset_to_baseline',
    });
    const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
      run: {
        uuid,
        status: 'passed' as const,
        displayId: 'issue-123-20260622-000000',
        issueNumber: 123,
        type: 'issue_to_pr' as const,
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      },
      phases: [],
    });

    const savedCwd = process.cwd();
    process.chdir(root);

    try {
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await expect(
        runsCmd.parseAsync(
          [
            'resume',
            '--uuid',
            uuid,
            '--from-phase',
            'validate',
            '--disposition',
            'reset_to_baseline',
          ],
          { from: 'user' },
        ),
      ).rejects.toThrow(/process.exit: 0/);

      expect(transitionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeDisposition: 'reset_to_baseline',
        }),
      );
      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeDisposition: 'reset_to_baseline',
        }),
      );
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('rejects omitted disposition for dirty needs_human_review with exit 1 and causes no mutations', async () => {
    const uuid = 'dirty-human-review-no-disposition-uuid';
    const issueNumber = 123;
    const root = setupTempRepo(uuid, 'validate', 'needs_human_review');

    // Create dirty worktree
    const wtDir = join(root, '.ai-worktrees', `issue-${issueNumber}`);
    mkdirSync(wtDir, { recursive: true });
    execSync('git init', { cwd: wtDir });
    execSync('git config user.name "Test"', { cwd: wtDir });
    execSync('git config user.email "test@test.com"', { cwd: wtDir });
    writeFileSync(join(wtDir, 'file.txt'), 'initial');
    execSync('git add . && git commit -m "initial"', { cwd: wtDir });
    writeFileSync(join(wtDir, 'dirty.txt'), 'dirty uncommitted');

    vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockImplementation(() => ({
      repoId: RepositoryId('owner/repo'),
      workerId: WorkerId(`cli-${process.pid}`),
      runId: RunId(uuid),
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 120_000),
      leaseToken: 'mocked-token' as LeaseToken,
    }));

    const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute');

    const savedCwd = process.cwd();
    process.chdir(root);

    try {
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await expect(
        runsCmd.parseAsync(['resume', '--uuid', uuid, '--from-phase', 'validate'], {
          from: 'user',
        }),
      ).rejects.toThrow(/process.exit: 1/);

      expect(exitSpy).toHaveBeenCalledWith(1);
      const errMsgs = consoleErrorSpy.mock.calls.map((c) => c[0]).join(' ');
      expect(errMsgs).toMatch(
        /explicit resume disposition is required for dirty needs_human_review runs/i,
      );

      expect(executeSpy).not.toHaveBeenCalled();

      // Assert no run mutation in database
      const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
      const db = openDatabase(dbPath);
      const runRow = db.prepare('SELECT status FROM runs WHERE uuid = ?').get(uuid) as {
        status: string;
      };
      expect(runRow.status).toBe('needs_human_review');
      db.close();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('defaults ordinary failed and cancelled resumes to reset_to_baseline', async () => {
    // 1. Failed run resume
    const failedUuid = 'default-failed-resume-uuid';
    const failedRoot = setupTempRepo(failedUuid, 'validate', 'failed');

    vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockImplementation(() => ({
      repoId: RepositoryId('owner/repo'),
      workerId: WorkerId(`cli-${process.pid}`),
      runId: RunId(failedUuid),
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 120_000),
      leaseToken: 'mocked-token' as LeaseToken,
    }));

    const transitionSpy = vi.spyOn(ResumeRun.prototype, 'transition').mockResolvedValue({
      savedStatus: 'failed',
      savedCompletedAt: null,
      savedFailureReason: null,
      savedCurrentPhase: null,
      savedCompletedPhases: [],
      savedSkippedPhases: [],
      savedSteps: [],
      effectiveDisposition: 'reset_to_baseline',
    });
    const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
      run: {
        uuid: failedUuid,
        status: 'passed' as const,
        displayId: 'issue-123-20260622-000000',
        issueNumber: 123,
        type: 'issue_to_pr' as const,
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      },
      phases: [],
    });

    const savedCwd = process.cwd();
    process.chdir(failedRoot);

    try {
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await expect(
        runsCmd.parseAsync(['resume', '--uuid', failedUuid, '--from-phase', 'validate'], {
          from: 'user',
        }),
      ).rejects.toThrow(/process.exit: 0/);

      expect(transitionSpy.mock.calls[0]?.[0]?.resumeDisposition).toBeUndefined();
      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeDisposition: 'reset_to_baseline',
        }),
      );
    } finally {
      process.chdir(savedCwd);
    }

    // 2. Cancelled run resume
    const cancelledUuid = 'default-cancelled-resume-uuid';
    const cancelledRoot = setupTempRepo(cancelledUuid, 'validate', 'cancelled');

    process.chdir(cancelledRoot);

    try {
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await expect(
        runsCmd.parseAsync(['resume', '--uuid', cancelledUuid, '--from-phase', 'validate'], {
          from: 'user',
        }),
      ).rejects.toThrow(/process.exit: 0/);

      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeDisposition: 'reset_to_baseline',
        }),
      );
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('defaults retry to reset_to_baseline', async () => {
    const uuid = 'default-retry-disposition-uuid';
    const root = setupTempRepo(uuid, 'validate', 'failed');

    vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockImplementation(() => ({
      repoId: RepositoryId('owner/repo'),
      workerId: WorkerId(`cli-${process.pid}`),
      runId: RunId(uuid),
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 120_000),
      leaseToken: 'mocked-token' as LeaseToken,
    }));

    const retrySpy = vi.spyOn(RetryFailedPhase.prototype, 'execute').mockResolvedValue({
      savedStatus: 'failed',
      savedCompletedAt: null,
      savedFailureReason: null,
      savedCurrentPhase: null,
      savedCompletedPhases: [],
      savedSkippedPhases: [],
      savedSteps: [],
      effectiveDisposition: 'reset_to_baseline',
    });
    const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
      run: {
        uuid,
        status: 'passed' as const,
        displayId: 'issue-123-20260622-000000',
        issueNumber: 123,
        type: 'issue_to_pr' as const,
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      },
      phases: [],
    });

    const savedCwd = process.cwd();
    process.chdir(root);

    try {
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await expect(
        runsCmd.parseAsync(['resume', '--uuid', uuid], { from: 'user' }),
      ).rejects.toThrow(/process.exit: 0/);

      expect(retrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: RunId(uuid),
        }),
      );
      expect(executeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resumeDisposition: 'reset_to_baseline',
        }),
      );
    } finally {
      process.chdir(savedCwd);
    }
  });
});
