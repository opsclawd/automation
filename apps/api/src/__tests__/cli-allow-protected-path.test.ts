import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram as originalBuildProgram } from '../cli.js';
import * as composeWithTargetMod from '../cli/compose-with-target.js';
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

function buildProgram(opts?: Parameters<typeof originalBuildProgram>[0]) {
  return originalBuildProgram({
    isCliTestSuite: true,
    bypassPlanValidation: true,
    ...opts,
  });
}

describe('CLI --allow-protected-path override (#1210)', () => {
  const tempDirs: string[] = [];
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
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

  function setupTempRepo() {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cli-allow-path-')));
    execSync('git init -b main', { cwd: root });
    execSync('git config user.name "Test"', { cwd: root });
    execSync('git config user.email "test@example.com"', { cwd: root });
    execSync('git remote add origin https://github.com/test-owner/test-repo.git', { cwd: root });
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    writeFileSync(
      join(root, '.ai-orchestrator.json'),
      JSON.stringify({
        executionPolicy: 'standard',
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
      'https://github.com/test-owner/test-repo.git',
      1,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.close();
    return { root, dbPath };
  }

  describe('run / start command', () => {
    it('threads single --allow-protected-path into composeOverrides', async () => {
      const { root } = setupTempRepo();
      process.chdir(root);

      const composeSpy = vi.spyOn(composeWithTargetMod, 'composeWithTarget');
      const program = buildProgram();

      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '1210',
        '--allow-protected-path',
        '.github/workflows/ci.yml',
      ]);

      expect(composeSpy).toHaveBeenCalledTimes(1);
      const callOptions = composeSpy.mock.calls[0]?.[1];
      expect(callOptions?.composeOverrides?.allowProtectedPaths).toEqual([
        '.github/workflows/ci.yml',
      ]);
    });

    it('threads repeatable --allow-protected-path options into composeOverrides', async () => {
      const { root } = setupTempRepo();
      process.chdir(root);

      const composeSpy = vi.spyOn(composeWithTargetMod, 'composeWithTarget');
      const program = buildProgram();

      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '1210',
        '--allow-protected-path',
        '.github/workflows/ci.yml',
        '--allow-protected-path',
        '.gitignore',
      ]);

      expect(composeSpy).toHaveBeenCalledTimes(1);
      const callOptions = composeSpy.mock.calls[0]?.[1];
      expect(callOptions?.composeOverrides?.allowProtectedPaths).toEqual([
        '.github/workflows/ci.yml',
        '.gitignore',
      ]);
    });

    it('leaves allowProtectedPaths undefined when flag is omitted on run', async () => {
      const { root } = setupTempRepo();
      process.chdir(root);

      const composeSpy = vi.spyOn(composeWithTargetMod, 'composeWithTarget');
      const program = buildProgram();

      await program.parseAsync(['node', 'orchestrator', 'run', '--issue', '1210']);

      expect(composeSpy).toHaveBeenCalledTimes(1);
      const callOptions = composeSpy.mock.calls[0]?.[1];
      expect(callOptions?.composeOverrides?.allowProtectedPaths).toBeUndefined();
    });

    it('works with the start alias', async () => {
      const { root } = setupTempRepo();
      process.chdir(root);

      const composeSpy = vi.spyOn(composeWithTargetMod, 'composeWithTarget');
      const program = buildProgram();

      await program.parseAsync([
        'node',
        'orchestrator',
        'start',
        '--issue',
        '1210',
        '--allow-protected-path',
        '.gitignore',
      ]);

      expect(composeSpy).toHaveBeenCalledTimes(1);
      const callOptions = composeSpy.mock.calls[0]?.[1];
      expect(callOptions?.composeOverrides?.allowProtectedPaths).toEqual(['.gitignore']);
    });
  });

  describe('runs resume command', () => {
    it('threads single --allow-protected-path into composeOverrides and runExecutor.execute', async () => {
      const { root, dbPath } = setupTempRepo();
      process.chdir(root);

      const db = openDatabase(dbPath);
      const runRepo = new RunRepository(db);
      const phaseRepo = new PhaseRepository(db);

      const testRun = createRun({
        uuid: 'test-resume-allow-uuid-1',
        displayId: '1210-1',
        repoId: RepositoryId('test-owner/test-repo'),
        issueNumber: 1210,
        startedAt: new Date(),
        executionPolicy: 'standard',
      });
      testRun.status = 'failed';
      testRun.currentPhase = PhaseName('create-pr');
      runRepo.insertIfNoActive(testRun);

      phaseRepo.insert({
        id: 'p-1' as PhaseId,
        runUuid: testRun.uuid,
        name: PhaseName('read_issue'),
        attempt: 1,
        status: 'passed',
        startedAt: new Date(),
        completedAt: new Date(),
      });
      db.close();

      vi.spyOn(ResumeRun.prototype, 'transition').mockResolvedValue({
        savedStatus: 'failed',
        savedCompletedAt: null,
        savedFailureReason: null,
        savedCurrentPhase: PhaseName('create-pr'),
        effectiveDisposition: 'reset_to_baseline',
      });

      const composeSpy = vi.spyOn(composeWithTargetMod, 'composeWithTarget');
      const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: { ...testRun, status: 'passed' },
        phases: [],
      });

      const program = buildProgram();
      await program.parseAsync([
        'node',
        'orchestrator',
        'runs',
        'resume',
        '--uuid',
        testRun.uuid,
        '--allow-protected-path',
        '.github/workflows/ci.yml',
        '--confirm',
      ]);

      expect(composeSpy).toHaveBeenCalledTimes(1);
      const callOptions = composeSpy.mock.calls[0]?.[1];
      expect(callOptions?.composeOverrides?.allowProtectedPaths).toEqual([
        '.github/workflows/ci.yml',
      ]);

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const executeInput = executeSpy.mock.calls[0]?.[0];
      expect(executeInput?.allowProtectedPaths).toEqual(['.github/workflows/ci.yml']);
    });

    it('threads repeatable --allow-protected-path into composeOverrides and runExecutor.execute on resume', async () => {
      const { root, dbPath } = setupTempRepo();
      process.chdir(root);

      const db = openDatabase(dbPath);
      const runRepo = new RunRepository(db);
      const phaseRepo = new PhaseRepository(db);

      const testRun = createRun({
        uuid: 'test-resume-allow-uuid-2',
        displayId: '1210-2',
        repoId: RepositoryId('test-owner/test-repo'),
        issueNumber: 1210,
        startedAt: new Date(),
        executionPolicy: 'standard',
      });
      testRun.status = 'failed';
      testRun.currentPhase = PhaseName('create-pr');
      runRepo.insertIfNoActive(testRun);

      phaseRepo.insert({
        id: 'p-1' as PhaseId,
        runUuid: testRun.uuid,
        name: PhaseName('read_issue'),
        attempt: 1,
        status: 'passed',
        startedAt: new Date(),
        completedAt: new Date(),
      });
      db.close();

      vi.spyOn(ResumeRun.prototype, 'transition').mockResolvedValue({
        savedStatus: 'failed',
        savedCompletedAt: null,
        savedFailureReason: null,
        savedCurrentPhase: PhaseName('create-pr'),
        effectiveDisposition: 'reset_to_baseline',
      });

      const composeSpy = vi.spyOn(composeWithTargetMod, 'composeWithTarget');
      const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: { ...testRun, status: 'passed' },
        phases: [],
      });

      const program = buildProgram();
      await program.parseAsync([
        'node',
        'orchestrator',
        'runs',
        'resume',
        '--uuid',
        testRun.uuid,
        '--allow-protected-path',
        '.github/workflows/ci.yml',
        '--allow-protected-path',
        '.gitignore',
        '--confirm',
      ]);

      expect(composeSpy).toHaveBeenCalledTimes(1);
      const callOptions = composeSpy.mock.calls[0]?.[1];
      expect(callOptions?.composeOverrides?.allowProtectedPaths).toEqual([
        '.github/workflows/ci.yml',
        '.gitignore',
      ]);

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const executeInput = executeSpy.mock.calls[0]?.[0];
      expect(executeInput?.allowProtectedPaths).toEqual(['.github/workflows/ci.yml', '.gitignore']);
    });

    it('leaves allowProtectedPaths undefined when omitted on runs resume', async () => {
      const { root, dbPath } = setupTempRepo();
      process.chdir(root);

      const db = openDatabase(dbPath);
      const runRepo = new RunRepository(db);
      const phaseRepo = new PhaseRepository(db);

      const testRun = createRun({
        uuid: 'test-resume-allow-uuid-3',
        displayId: '1210-3',
        repoId: RepositoryId('test-owner/test-repo'),
        issueNumber: 1210,
        startedAt: new Date(),
        executionPolicy: 'standard',
      });
      testRun.status = 'failed';
      testRun.currentPhase = PhaseName('create-pr');
      runRepo.insertIfNoActive(testRun);

      phaseRepo.insert({
        id: 'p-1' as PhaseId,
        runUuid: testRun.uuid,
        name: PhaseName('read_issue'),
        attempt: 1,
        status: 'passed',
        startedAt: new Date(),
        completedAt: new Date(),
      });
      db.close();

      vi.spyOn(ResumeRun.prototype, 'transition').mockResolvedValue({
        savedStatus: 'failed',
        savedCompletedAt: null,
        savedFailureReason: null,
        savedCurrentPhase: PhaseName('create-pr'),
        effectiveDisposition: 'reset_to_baseline',
      });

      const composeSpy = vi.spyOn(composeWithTargetMod, 'composeWithTarget');
      const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: { ...testRun, status: 'passed' },
        phases: [],
      });

      const program = buildProgram();
      await program.parseAsync([
        'node',
        'orchestrator',
        'runs',
        'resume',
        '--uuid',
        testRun.uuid,
        '--confirm',
      ]);

      expect(composeSpy).toHaveBeenCalledTimes(1);
      const callOptions = composeSpy.mock.calls[0]?.[1];
      expect(callOptions?.composeOverrides?.allowProtectedPaths).toBeUndefined();

      expect(executeSpy).toHaveBeenCalledTimes(1);
      const executeInput = executeSpy.mock.calls[0]?.[0];
      expect(executeInput?.allowProtectedPaths).toBeUndefined();
    });
  });
});
