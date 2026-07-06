import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../cli.js';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';
import { RunExecutor as RunExecutorApp, ResumeRun, RetryFailedPhase } from '@ai-sdlc/application';
import { WorkerLeaseRepository } from '@ai-sdlc/infrastructure';
import { WorkerId, RepositoryId, RunId } from '@ai-sdlc/domain';

const tempDirs: string[] = [];
function trackDir<T extends string>(fn: () => T): T {
  const result = fn();
  tempDirs.push(result);
  return result;
}

function initRepo(label: string): string {
  const dir = trackDir(() => mkdtempSync(join(tmpdir(), `ai-orch-target-${label}-`)));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', dir], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't'], { stdio: 'pipe' });
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  writeFileSync(join(dir, 'README.md'), 't');
  execFileSync('git', ['-C', dir, 'add', '.'], { stdio: 'pipe' });
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', 'init'], { stdio: 'pipe' });
  return dir;
}

function writeOrchestratorConfig(root: string): void {
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
}

function insertRun(
  repoRoot: string,
  uuid: string,
  displayId: string,
  issue: number,
  status: string,
  repoId: string,
): void {
  const dbPath = join(repoRoot, '.ai-runs', 'orchestrator.sqlite');
  const db = openDatabase(dbPath);
  applyMigrations(db);
  db.prepare(
    `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(uuid, displayId, repoId, issue, 'issue_to_pr', status, '[]', new Date().toISOString());
  db.close();
}

describe('Cross-repo run management', () => {
  beforeEach(() => {
    vi.spyOn(WorkerLeaseRepository.prototype, 'acquire').mockReturnValue({
      repoId: RepositoryId('owner/repo'),
      workerId: WorkerId(`cli-${process.pid}`),
      runId: 'placeholder-uuid' as unknown as RunId,
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 120_000),
    });
    vi.spyOn(WorkerLeaseRepository.prototype, 'heartbeat').mockReturnValue(undefined);
    vi.spyOn(WorkerLeaseRepository.prototype, 'release').mockReturnValue(undefined);
    vi.spyOn(RunExecutorApp.prototype, 'execute').mockResolvedValue({
      run: {
        uuid: 'placeholder-uuid',
        status: 'passed' as const,
        displayId: 'placeholder-display',
        issueNumber: 1,
        type: 'issue_to_pr',
        completedPhases: [],
        skippedPhases: [],
        startedAt: new Date(),
      },
      phases: [],
    });
    vi.spyOn(ResumeRun.prototype, 'transition').mockResolvedValue(undefined as never);
    vi.spyOn(RetryFailedPhase.prototype, 'execute').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(): { orchestrator: string; target: string; other: string } {
    const orchestrator = initRepo('orch');
    writeOrchestratorConfig(orchestrator);
    const target = initRepo('target');
    const other = initRepo('other');
    return { orchestrator, target, other };
  }

  it('runs cancel finds a run by --uuid in the target repo', async () => {
    const { orchestrator, target, other } = setup();
    const runUuid = 'cross-cancel-uuid';
    insertRun(target, runUuid, 'issue-501-20260706-000000', 501, 'running', 'owner/repo');
    const savedCwd = process.cwd();
    process.chdir(orchestrator);
    try {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['cancel', '--uuid', runUuid, '--target-repo-root', target], {
        from: 'user',
      });
      expect(stdoutSpy.mock.calls.map((c) => String(c[0])).join('')).toMatch(
        /cancelled successfully/i,
      );
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();

      // Cross-repo miss: pointing at the wrong target must report "No run found"
      const consoleErrs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy2 = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program2 = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd2 = program2.commands.find((c) => c.name() === 'runs')!;
      runsCmd2.exitOverride();
      await runsCmd2.parseAsync(['cancel', '--uuid', runUuid, '--target-repo-root', other], {
        from: 'user',
      });
      expect(exitSpy2).toHaveBeenCalledWith(1);
      // "No run found" surfaces as a thrown Error caught by the outer try/catch
      expect(consoleErrs.join('')).toMatch(/No run found for uuid/i);
      errSpy.mockRestore();
      exitSpy2.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('runs check-merge-ready finds a run by --uuid in the target repo', async () => {
    const { orchestrator, target, other } = setup();
    const runUuid = 'cross-cmr-uuid';
    insertRun(target, runUuid, 'issue-502-20260706-000000', 502, 'waiting', 'owner/repo');
    const savedCwd = process.cwd();
    process.chdir(orchestrator);
    try {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram();
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(
        ['check-merge-ready', '--uuid', runUuid, '--target-repo-root', target],
        { from: 'user' },
      );
      expect(exitSpy).toHaveBeenCalledWith(0);
      stdoutSpy.mockRestore();
      exitSpy.mockRestore();

      // Cross-repo miss
      const consoleErrs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy2 = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program2 = buildProgram();
      const runsCmd2 = program2.commands.find((c) => c.name() === 'runs')!;
      runsCmd2.exitOverride();
      await runsCmd2.parseAsync(
        ['check-merge-ready', '--uuid', runUuid, '--target-repo-root', other],
        { from: 'user' },
      );
      expect(exitSpy2).toHaveBeenCalledWith(1);
      expect(consoleErrs.join('')).toMatch(/No run found for uuid/i);
      errSpy.mockRestore();
      exitSpy2.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('runs execute finds a run by --uuid in the target repo', async () => {
    const { orchestrator, target, other } = setup();
    const runUuid = 'cross-exec-uuid';
    insertRun(target, runUuid, 'issue-503-20260706-000000', 503, 'queued', 'owner/repo');
    const savedCwd = process.cwd();
    process.chdir(orchestrator);
    try {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['execute', '--uuid', runUuid, '--target-repo-root', target], {
        from: 'user',
      });
      stdoutSpy.mockRestore();
      exitSpy.mockRestore();

      // Cross-repo miss
      const consoleErrs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy2 = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program2 = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd2 = program2.commands.find((c) => c.name() === 'runs')!;
      runsCmd2.exitOverride();
      await runsCmd2.parseAsync(['execute', '--uuid', runUuid, '--target-repo-root', other], {
        from: 'user',
      });
      expect(exitSpy2).toHaveBeenCalledWith(1);
      expect(consoleErrs.join('')).toMatch(/no run found/i);
      errSpy.mockRestore();
      exitSpy2.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('runs resume finds a run by --uuid in the target repo', async () => {
    const { orchestrator, target, other } = setup();
    const runUuid = 'cross-resume-uuid';
    insertRun(target, runUuid, 'issue-504-20260706-000000', 504, 'failed', 'owner/repo');
    const savedCwd = process.cwd();
    process.chdir(orchestrator);
    try {
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['resume', '--uuid', runUuid, '--target-repo-root', target], {
        from: 'user',
      });
      stdoutSpy.mockRestore();
      exitSpy.mockRestore();

      // Cross-repo miss
      const consoleErrs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy2 = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program2 = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd2 = program2.commands.find((c) => c.name() === 'runs')!;
      runsCmd2.exitOverride();
      await runsCmd2.parseAsync(['resume', '--uuid', runUuid, '--target-repo-root', other], {
        from: 'user',
      });
      expect(exitSpy2).toHaveBeenCalledWith(1);
      expect(consoleErrs.join('')).toMatch(/no run found/i);
      errSpy.mockRestore();
      exitSpy2.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('runs logs finds a run by --issue in the target repo', async () => {
    const { orchestrator, target, other } = setup();
    const runUuid = 'cross-logs-uuid';
    insertRun(target, runUuid, 'issue-505-20260706-000000', 505, 'running', 'owner/repo');
    const savedCwd = process.cwd();
    process.chdir(orchestrator);
    try {
      // For logs we need the run to reach a terminal state to exit; insert
      // an additional terminal run record and let the tailer loop bail.
      // Patch the run to terminal so the loop terminates.
      const dbPath = join(target, '.ai-runs', 'orchestrator.sqlite');
      const db = openDatabase(dbPath);
      db.prepare(`UPDATE runs SET status = 'passed' WHERE uuid = ?`).run(runUuid);
      db.close();
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(
        ['logs', '--issue', '505', '--no-follow', '--target-repo-root', target],
        { from: 'user' },
      );
      // The logs loop should not throw "No run found"
      stdoutSpy.mockRestore();
      exitSpy.mockRestore();

      // Cross-repo miss: the run is in `target`, not `other`
      const consoleErrs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy2 = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program2 = buildProgram({ composeOverrides: { repoFullName: 'owner/repo' } });
      const runsCmd2 = program2.commands.find((c) => c.name() === 'runs')!;
      runsCmd2.exitOverride();
      await runsCmd2.parseAsync(
        ['logs', '--issue', '505', '--no-follow', '--target-repo-root', other],
        { from: 'user' },
      );
      expect(exitSpy2).toHaveBeenCalledWith(1);
      expect(consoleErrs.join('')).toMatch(/no run found for issue 505/i);
      errSpy.mockRestore();
      exitSpy2.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });

  it('rejects a non-git --target-repo-root with the canonical error', async () => {
    const { orchestrator } = setup();
    const nonGitDir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-target-nogit-')));
    const savedCwd = process.cwd();
    process.chdir(orchestrator);
    try {
      const consoleErrs: string[] = [];
      const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
        consoleErrs.push(String(msg));
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const program = buildProgram();
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();
      await runsCmd.parseAsync(['logs', '--issue', '999', '--target-repo-root', nonGitDir], {
        from: 'user',
      });
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleErrs.join('')).toMatch(/not inside a git working tree/);
      errSpy.mockRestore();
      exitSpy.mockRestore();
    } finally {
      process.chdir(savedCwd);
    }
  });
});
