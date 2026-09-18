import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../cli.js';
import { ReleaseBatchId, JobId } from '@ai-sdlc/domain';
import { RunExecutor } from '@ai-sdlc/application';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';

vi.setConfig({ testTimeout: 30000 });

describe('CLI runtime pin admission and status', () => {
  let stdoutOutput: string[] = [];
  let stderrOutput: string[] = [];
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  const tempDirs: string[] = [];

  function fakeScript(exitCode = 0): string {
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-pin-cli-'));
    tempDirs.push(dir);
    const path = join(dir, 'run.sh');
    writeFileSync(path, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  function createTestDb(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ai-orch-pin-db-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'orchestrator.sqlite');
    const db = openDatabase(dbPath);
    applyMigrations(db);
    db.prepare(
      `INSERT OR REPLACE INTO repositories (
        id, full_name, owner, name, local_base_path, default_branch, remote_url,
        enabled, max_concurrent_runs, config_metadata, health_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'owner/repo',
      'owner/repo',
      'owner',
      'repo',
      dir,
      'main',
      'https://github.com/owner/repo.git',
      1,
      1,
      '{}',
      'healthy',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.close();
    return dbPath;
  }

  beforeEach(() => {
    stdoutOutput = [];
    stderrOutput = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ) => {
      stdoutOutput.push(String(chunk));
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      if (callback) callback();
      return true;
    }) as never);
    stderrSpy = vi.spyOn(console, 'error').mockImplementation(((...args: unknown[]) => {
      stderrOutput.push(args.map(String).join(' '));
    }) as never);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('orchestrator run --runtime', () => {
    it('passes valid runtime pin to StartIssueRun and logs pin', async () => {
      const scriptPath = fakeScript(0);
      const dbPath = createTestDb();

      const program = buildProgram({
        isCliTestSuite: true,
        composeOverrides: {
          repoFullName: 'owner/repo',
          dbPath,
        },
      });

      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '42',
        '--executor',
        'bash',
        '--script',
        scriptPath,
        '--runtime',
        'claude-code',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(0);
      const parsed = JSON.parse(stdoutOutput.join(''));
      expect(parsed.pinnedRuntime).toBe('claude-code');
      expect(parsed.status).toBe('passed');

      const allStderr = stderrOutput.join('\n');
      expect(allStderr).toContain('Runtime pin: claude-code');
    });

    it('rejects invalid runtime pin fast with exit code 1', async () => {
      const scriptPath = fakeScript(0);
      const program = buildProgram({
        isCliTestSuite: true,
        composeOverrides: { repoFullName: 'owner/repo' },
      });

      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '42',
        '--executor',
        'bash',
        '--script',
        scriptPath,
        '--runtime',
        'invalid-runtime',
      ]);

      expect(exitSpy).toHaveBeenCalledWith(1);
      const allStderr = stderrOutput.join('\n');
      expect(allStderr).toContain(
        '--runtime must be one of: claude-code, antigravity, codex, opencode',
      );
      expect(allStderr).toContain('got "invalid-runtime"');
    });
  });

  describe('orchestrator runs status', () => {
    it('displays Runtime Pin in formatted output for pinned run', async () => {
      const dbPath = createTestDb();
      const db = openDatabase(dbPath);
      db.prepare(
        `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at, pinned_runtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        '00000000-0000-0000-0000-000000000001',
        'issue-42-001',
        'owner/repo',
        42,
        'issue_to_pr',
        'passed',
        '[]',
        new Date('2026-09-11T12:00:00Z').toISOString(),
        'antigravity',
      );
      db.close();

      const program = buildProgram({
        isCliTestSuite: true,
        composeOverrides: {
          repoFullName: 'owner/repo',
          dbPath,
        },
      });

      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await runsCmd.parseAsync(['status', '--issue', '42'], { from: 'user' });

      const allStdout = stdoutOutput.join('');
      expect(allStdout).toContain('Runtime Pin:     antigravity');
      expect(allStdout).toContain('Status:          passed');
      expect(allStdout).toContain('Issue:           #42');
    });

    it('displays unpinned when run has no runtime pin', async () => {
      const dbPath = createTestDb();
      const db = openDatabase(dbPath);
      db.prepare(
        `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at, pinned_runtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        '00000000-0000-0000-0000-000000000002',
        'issue-43-001',
        'owner/repo',
        43,
        'issue_to_pr',
        'running',
        '[]',
        new Date('2026-09-11T12:00:00Z').toISOString(),
        null,
      );
      db.close();

      const program = buildProgram({
        isCliTestSuite: true,
        composeOverrides: {
          repoFullName: 'owner/repo',
          dbPath,
        },
      });

      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await runsCmd.parseAsync(['status', '--issue', '43'], { from: 'user' });

      const allStdout = stdoutOutput.join('');
      expect(allStdout).toContain('Runtime Pin:     unpinned');
    });

    it('outputs JSON with pinnedRuntime when --json is provided', async () => {
      const dbPath = createTestDb();
      const db = openDatabase(dbPath);
      db.prepare(
        `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, started_at, pinned_runtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        '00000000-0000-0000-0000-000000000003',
        'issue-44-001',
        'owner/repo',
        44,
        'issue_to_pr',
        'passed',
        '[]',
        new Date('2026-09-11T12:00:00Z').toISOString(),
        'codex',
      );
      db.close();

      const program = buildProgram({
        isCliTestSuite: true,
        composeOverrides: {
          repoFullName: 'owner/repo',
          dbPath,
        },
      });

      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await runsCmd.parseAsync(
        ['status', '--uuid', '00000000-0000-0000-0000-000000000003', '--json'],
        { from: 'user' },
      );

      const allStdout = stdoutOutput.join('');
      const parsed = JSON.parse(allStdout);
      expect(parsed.pinnedRuntime).toBe('codex');
      expect(parsed.issueNumber).toBe(44);
    });
  });

  describe('orchestrator release-batch start --runtime', () => {
    it('passes runtime pin to startReleaseBatch and prints pin in summary', async () => {
      const mockBatch = {
        id: ReleaseBatchId('batch-2026-09-11-101-102'),
        repoId: 'owner/repo',
        sourceBranch: 'main',
        sourceStartSha: 'sha-12345',
        releaseBranch: 'release/2026-09-11-batch-101-102',
        status: 'building',
        currentPosition: 1,
        createdAt: new Date(),
        items: [
          { position: 1, issueNumber: 101, status: 'active', runUuid: 'uuid-101' },
          { position: 2, issueNumber: 102, status: 'pending' },
        ],
      };

      const mockStartReleaseBatch = {
        execute: vi.fn().mockResolvedValue({
          batchId: ReleaseBatchId('batch-2026-09-11-101-102'),
          releaseBranch: 'release/2026-09-11-batch-101-102',
          sourceBranch: 'main',
          sourceStartSha: 'sha-12345',
          runUuid: 'uuid-101',
          runDisplayId: 'issue-101-run',
          jobId: JobId('job-101'),
          batch: mockBatch,
        }),
      };

      const program = buildProgram({
        isCliTestSuite: true,
        composeOverrides: {
          repoFullName: 'owner/repo',
          startReleaseBatch:
            mockStartReleaseBatch as unknown as import('@ai-sdlc/application').StartReleaseBatch,
        },
      });

      const batchCmd = program.commands.find((c) => c.name() === 'release-batch')!;
      batchCmd.exitOverride();

      await batchCmd.parseAsync(['start', '--issues', '101,102', '--runtime', 'opencode'], {
        from: 'user',
      });

      expect(mockStartReleaseBatch.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          issueNumbers: [101, 102],
          pinnedRuntime: 'opencode',
        }),
      );

      const allStdout = stdoutOutput.join('');
      expect(allStdout).toContain('Runtime Pin:    opencode');
    });

    it('rejects invalid runtime pin fast on release-batch start', async () => {
      const program = buildProgram({
        isCliTestSuite: true,
        composeOverrides: { repoFullName: 'owner/repo' },
      });

      const batchCmd = program.commands.find((c) => c.name() === 'release-batch')!;
      batchCmd.exitOverride();

      await batchCmd.parseAsync(['start', '--issues', '101,102', '--runtime', 'bad-runtime'], {
        from: 'user',
      });

      expect(exitSpy).toHaveBeenCalledWith(1);
      const allStderr = stderrOutput.join('\n');
      expect(allStderr).toContain(
        '--runtime must be one of: claude-code, antigravity, codex, opencode',
      );
      expect(allStderr).toContain('got "bad-runtime"');
    });
  });

  describe('orchestrator runs resume --runtime', () => {
    it('rejects invalid runtime pin fast on runs resume', async () => {
      const program = buildProgram({
        isCliTestSuite: true,
        composeOverrides: { repoFullName: 'owner/repo' },
      });
      const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
      runsCmd.exitOverride();

      await runsCmd.parseAsync(
        ['resume', '--uuid', '00000000-0000-0000-0000-000000000010', '--runtime', 'bad-runtime'],
        { from: 'user' },
      );

      expect(exitSpy).toHaveBeenCalledWith(1);
      const allStderr = stderrOutput.join('\n');
      expect(allStderr).toContain(
        '--runtime must be one of: claude-code, antigravity, codex, opencode',
      );
      expect(allStderr).toContain('got "bad-runtime"');
    });

    it('pins unpinned failed run when resuming with --runtime and updates record', async () => {
      const dbPath = createTestDb();
      const db = openDatabase(dbPath);
      const uuid = '00000000-0000-0000-0000-000000000010';
      db.prepare(
        `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, current_phase, completed_phases, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        uuid,
        'issue-10-run',
        'owner/repo',
        10,
        'issue_to_pr',
        'failed',
        'implement',
        '["read_issue","plan"]',
        new Date('2026-09-11T12:00:00Z').toISOString(),
      );
      db.close();

      const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: {
          uuid,
          status: 'passed' as const,
          displayId: 'issue-10-run',
          issueNumber: 10,
          type: 'issue_to_pr' as const,
          completedPhases: ['read_issue', 'plan', 'implement'],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [],
      });

      try {
        const program = buildProgram({
          isCliTestSuite: true,
          composeOverrides: {
            repoFullName: 'owner/repo',
            dbPath,
          },
        });

        const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
        runsCmd.exitOverride();

        await runsCmd.parseAsync(['resume', '--uuid', uuid, '--runtime', 'antigravity'], {
          from: 'user',
        });

        const allStderr = stderrOutput.join('\n');
        expect(allStderr).toContain('Runtime pin: antigravity (pinned at resume)');

        const verifyDb = openDatabase(dbPath);
        const row = verifyDb
          .prepare('SELECT pinned_runtime, status FROM runs WHERE uuid = ?')
          .get(uuid) as {
          pinned_runtime: string;
          status: string;
        };
        verifyDb.close();
        expect(row.pinned_runtime).toBe('antigravity');
      } finally {
        executeSpy.mockRestore();
      }
    });

    it('explicitly re-pins an already-pinned failed run when resuming with new --runtime', async () => {
      const dbPath = createTestDb();
      const db = openDatabase(dbPath);
      const uuid = '00000000-0000-0000-0000-000000000011';
      db.prepare(
        `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, current_phase, completed_phases, started_at, pinned_runtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        uuid,
        'issue-11-run',
        'owner/repo',
        11,
        'issue_to_pr',
        'failed',
        'implement',
        '["read_issue","plan"]',
        new Date('2026-09-11T12:00:00Z').toISOString(),
        'claude-code',
      );
      db.close();

      const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: {
          uuid,
          status: 'passed' as const,
          displayId: 'issue-11-run',
          issueNumber: 11,
          type: 'issue_to_pr' as const,
          completedPhases: ['read_issue', 'plan', 'implement'],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [],
      });

      try {
        const program = buildProgram({
          isCliTestSuite: true,
          composeOverrides: {
            repoFullName: 'owner/repo',
            dbPath,
          },
        });

        const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
        runsCmd.exitOverride();

        await runsCmd.parseAsync(['resume', '--uuid', uuid, '--runtime', 'codex'], {
          from: 'user',
        });

        const allStderr = stderrOutput.join('\n');
        expect(allStderr).toContain('Runtime pin: codex (re-pinned from claude-code at resume)');

        const verifyDb = openDatabase(dbPath);
        const row = verifyDb
          .prepare('SELECT pinned_runtime, status FROM runs WHERE uuid = ?')
          .get(uuid) as {
          pinned_runtime: string;
          status: string;
        };
        verifyDb.close();
        expect(row.pinned_runtime).toBe('codex');
      } finally {
        executeSpy.mockRestore();
      }
    });

    it('preserves existing pin when resuming without --runtime', async () => {
      const dbPath = createTestDb();
      const db = openDatabase(dbPath);
      const uuid = '00000000-0000-0000-0000-000000000012';
      db.prepare(
        `INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, current_phase, completed_phases, started_at, pinned_runtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        uuid,
        'issue-12-run',
        'owner/repo',
        12,
        'issue_to_pr',
        'failed',
        'implement',
        '["read_issue","plan"]',
        new Date('2026-09-11T12:00:00Z').toISOString(),
        'claude-code',
      );
      db.close();

      const executeSpy = vi.spyOn(RunExecutor.prototype, 'execute').mockResolvedValue({
        run: {
          uuid,
          status: 'passed' as const,
          displayId: 'issue-12-run',
          issueNumber: 12,
          type: 'issue_to_pr' as const,
          completedPhases: ['read_issue', 'plan', 'implement'],
          skippedPhases: [],
          startedAt: new Date(),
        },
        phases: [],
      });

      try {
        const program = buildProgram({
          isCliTestSuite: true,
          composeOverrides: {
            repoFullName: 'owner/repo',
            dbPath,
          },
        });

        const runsCmd = program.commands.find((c) => c.name() === 'runs')!;
        runsCmd.exitOverride();

        await runsCmd.parseAsync(['resume', '--uuid', uuid], { from: 'user' });

        const allStderr = stderrOutput.join('\n');
        expect(allStderr).toContain('Runtime pin: claude-code');

        const verifyDb = openDatabase(dbPath);
        const row = verifyDb
          .prepare('SELECT pinned_runtime FROM runs WHERE uuid = ?')
          .get(uuid) as {
          pinned_runtime: string;
        };
        verifyDb.close();
        expect(row.pinned_runtime).toBe('claude-code');
      } finally {
        executeSpy.mockRestore();
      }
    });
  });

  describe('orchestrator release-batch resume --runtime', () => {
    it('rejects --runtime flag on release-batch resume fast with actionable guidance', async () => {
      const dbPath = createTestDb();
      const db = openDatabase(dbPath);
      const batchId = 'batch-2026-09-18-001';
      const runUuid = '00000000-0000-0000-0000-000000000099';
      db.prepare(
        `INSERT INTO release_batches (id, repo_id, source_branch, release_branch, source_start_sha, status, current_position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        batchId,
        'owner/repo',
        'main',
        'release/2026-09-18-001',
        'start-sha',
        'blocked',
        1,
        new Date().toISOString(),
      );
      db.prepare(
        `INSERT INTO release_batch_items (release_batch_id, position, issue_number, status, run_uuid)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(batchId, 1, 99, 'blocked', runUuid);
      db.close();

      const program = buildProgram({
        isCliTestSuite: true,
        composeOverrides: {
          repoFullName: 'owner/repo',
          dbPath,
        },
      });

      const batchCmd = program.commands.find((c) => c.name() === 'release-batch')!;
      batchCmd.exitOverride();

      await batchCmd.parseAsync(['resume', '-i', batchId, '--runtime', 'antigravity'], {
        from: 'user',
      });

      expect(exitSpy).toHaveBeenCalledWith(1);
      const allStderr = stderrOutput.join('\n');
      expect(allStderr).toContain('release-batch resume does not support --runtime directly');
      expect(allStderr).toContain(`runs resume --uuid ${runUuid} --runtime antigravity`);
      expect(allStderr).toContain(`release-batch resume --id ${batchId}`);
    });
  });
});
