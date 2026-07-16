import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, current_phase, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuid,
      'issue-123-20260622-000000',
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
      savedCompletedAt: null,
      savedFailureReason: null,
      savedCurrentPhase: null,
      savedCompletedPhases: [],
      savedSkippedPhases: [],
      savedSteps: [],
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
      savedCompletedAt: null,
      savedFailureReason: null,
      savedCurrentPhase: null,
      savedCompletedPhases: [],
      savedSkippedPhases: [],
      savedSteps: [],
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
      savedCompletedAt: null,
      savedFailureReason: null,
      savedCurrentPhase: null,
      savedCompletedPhases: [],
      savedSkippedPhases: [],
      savedSteps: [],
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
      expect(executeSpy).toHaveBeenCalled();
    } finally {
      process.chdir(savedCwd);
    }
  });
});
