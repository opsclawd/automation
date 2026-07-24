import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../cli.js';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';
import { RunExecutor, RetryFailedPhase } from '@ai-sdlc/application';
import { WorkerLeaseRepository } from '@ai-sdlc/infrastructure';
import {
  WorkerId,
  RepositoryId,
  RunId,
  LeaseToken,
  WorkerLeaseConflictError,
} from '@ai-sdlc/domain';

describe('CLI runs resume orphan reconciliation', () => {
  const tempDirs: string[] = [];
  let consoleErrorSpy: ReturnType<typeof vi.spyOn<typeof console, 'error'>>;
  let exitSpy: ReturnType<typeof vi.spyOn<typeof process, 'exit'>>;

  beforeEach(() => {
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

  function setupTempRepoWithRunningRun(
    uuid: string,
    currentPhase: string,
    pid: number | null,
    existingLeaseForRun: boolean = false,
  ) {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cli-orphan-')));
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
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, current_phase, completed_phases, started_at, pid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uuid,
      'issue-123-20260622-000000',
      123,
      'issue_to_pr',
      'running',
      currentPhase,
      '[]',
      new Date().toISOString(),
      pid,
    );

    const phaseCompletedAt = new Date(Date.now() - 60000).toISOString();
    db.prepare(
      `INSERT INTO phases (id, run_uuid, name, status, attempt, completed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      `${uuid}-${currentPhase}-1`,
      uuid,
      currentPhase,
      'needs_human_review',
      1,
      phaseCompletedAt,
    );

    if (existingLeaseForRun) {
      db.prepare(
        `INSERT INTO worker_leases (repo_id, worker_id, run_id, acquired_at, heartbeat_at, expires_at, lease_token)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'owner/repo',
        `cli-${pid ?? 99999}`,
        uuid,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date(Date.now() + 120_000).toISOString(),
        'stale-lease-token',
      );
    }

    db.close();
    return root;
  }

  it('resume reconciles a dead running run from its latest phase and continues', async () => {
    const uuid = 'dead-running-reconciles-uuid';
    const impossiblePid = 999999999;
    const root = setupTempRepoWithRunningRun(uuid, 'validate', impossiblePid);

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

      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(acquireSpy).toHaveBeenCalled();
      expect(retrySpy).toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalled();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('resume rejects a running run whose PID is alive', async () => {
    const uuid = 'alive-running-denied-uuid';
    const alivePid = process.pid;
    const root = setupTempRepoWithRunningRun(uuid, 'validate', alivePid);

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
      ).rejects.toThrow(/process.exit: 1/);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(acquireSpy).not.toHaveBeenCalled();
      expect(retrySpy).not.toHaveBeenCalled();
      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('resume leaves a pid-less running run unchanged', async () => {
    const uuid = 'pid-less-running-unchanged-uuid';
    const root = setupTempRepoWithRunningRun(uuid, 'validate', null);

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
      ).rejects.toThrow(/process.exit: 1/);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(acquireSpy).not.toHaveBeenCalled();
      expect(retrySpy).not.toHaveBeenCalled();
      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('resume releases a stale lease owned by the same dead run before acquiring', async () => {
    const uuid = 'same-run-lease-release-uuid';
    const impossiblePid = 999999999;
    const root = setupTempRepoWithRunningRun(uuid, 'validate', impossiblePid, true);

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
          leaseToken: 'new-mocked-token' as LeaseToken,
        };
      });

    const releaseSpy = vi
      .spyOn(WorkerLeaseRepository.prototype, 'release')
      .mockImplementation(() => {});

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

      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(releaseSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repoId: RepositoryId('owner/repo'),
          runId: RunId(uuid),
        }),
      );
      expect(acquireSpy).toHaveBeenCalled();
      expect(retrySpy).toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalled();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('resume preserves an unrelated lease and reports the conflict', async () => {
    const uuid = 'unrelated-lease-conflict-uuid';
    const impossiblePid = 999999999;
    const root = setupTempRepoWithRunningRun(uuid, 'validate', impossiblePid, false);

    const unrelatedUuid = 'unrelated-run-lease-uuid';
    const dbPath = join(root, '.ai-runs', 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    db.prepare(
      `INSERT INTO runs (uuid, display_id, issue_number, type, status, current_phase, completed_phases, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      unrelatedUuid,
      'issue-456-20260622-000000',
      456,
      'issue_to_pr',
      'running',
      'implement',
      '[]',
      new Date().toISOString(),
    );
    db.prepare(
      `INSERT INTO worker_leases (repo_id, worker_id, run_id, acquired_at, heartbeat_at, expires_at, lease_token)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'owner/repo',
      `cli-12345`,
      unrelatedUuid,
      new Date().toISOString(),
      new Date().toISOString(),
      new Date(Date.now() + 120_000).toISOString(),
      'unrelated-lease-token',
    );
    db.close();

    const acquireSpy = vi
      .spyOn(WorkerLeaseRepository.prototype, 'acquire')
      .mockImplementation(() => {
        throw new WorkerLeaseConflictError(RepositoryId('owner/repo'), WorkerId('cli-12345'));
      });

    const releaseSpy = vi
      .spyOn(WorkerLeaseRepository.prototype, 'release')
      .mockImplementation(() => {});

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
      ).rejects.toThrow(/process.exit: 1/);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(releaseSpy).not.toHaveBeenCalled();
      expect(acquireSpy).toHaveBeenCalled();
      expect(retrySpy).not.toHaveBeenCalled();
      expect(executeSpy).not.toHaveBeenCalled();

      const errMsgs = consoleErrorSpy.mock.calls.map((c) => c[0]).join(' ');
      expect(errMsgs).toMatch(/active lease|another run is in progress/i);
    } finally {
      process.chdir(savedCwd);
    }
  });
});
