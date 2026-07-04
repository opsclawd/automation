import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram as originalBuildProgram } from '../cli.js';
import { WorkerScheduler } from '../worker-scheduler.js';
import { JobQueueRepository } from '@ai-sdlc/infrastructure';
import { JobId, RepositoryId, RunId, IssueNumber } from '@ai-sdlc/domain';

function buildProgram(opts?: Parameters<typeof originalBuildProgram>[0]) {
  return originalBuildProgram({
    isCliTestSuite: true,
    bypassPlanValidation: true,
    ...opts,
  });
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function trackDir<T>(fn: () => T): T {
  const result = fn();
  tempDirs.push(result);
  return result;
}

function fakeScript(exitCode: number): string {
  const dir = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-cli-fail-')));
  const path = join(dir, 'run.sh');
  writeFileSync(path, `#!/usr/bin/env bash\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe('CLI failure output', () => {
  it('shows run UUID, failure reason, and resume command on TS executor failure', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-ts-fail-output-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
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
          phaseProfiles: { read_issue: { profile: 'test' } },
        },
      }),
    );

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      vi.spyOn(WorkerScheduler.prototype, 'runUntilComplete').mockResolvedValue(undefined);
      vi.spyOn(JobQueueRepository.prototype, 'findById').mockReturnValue({
        id: JobId('mock-job'),
        runId: RunId('mock-run-uuid'),
        repoId: RepositoryId('owner/repo'),
        issueNumber: IssueNumber(1),
        status: 'failed',
        priority: 0,
        attempts: 1,
        createdAt: new Date(),
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });

      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '1',
        '--executor',
        'ts',
        '--script',
        '/dev/null',
      ]);

      const output = consoleErrorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('Run failed: worker loop terminated without finalizing run');
      expect(output).toContain('Run UUID:');
      expect(output).toContain('Resume with: orchestrator runs resume --uuid');
      expect(output).not.toContain('--confirm');
    } finally {
      process.chdir(savedCwd);
    }
  }, 20000);

  it('shows run UUID and resume command on Bash executor failure', async () => {
    const root = trackDir(() => mkdtempSync(join(tmpdir(), 'ai-orch-bash-fail-output-')));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    const scriptPath = fakeScript(1);

    const savedCwd = process.cwd();
    process.chdir(root);
    try {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      vi.spyOn(process.stdout, 'write').mockImplementation(((
        chunk: string | Uint8Array,
        cbOrEnc?: unknown,
        cb2?: unknown,
      ) => {
        const cb = typeof cbOrEnc === 'function' ? cbOrEnc : cb2;
        if (typeof cb === 'function') (cb as (e?: Error | null) => void)(null);
        return true;
      }) as never);

      const program = buildProgram({
        composeOverrides: {
          repoRoot: root,
          repoFullName: 'owner/repo',
          runStartupSweeps: false,
        },
      });

      await program.parseAsync([
        'node',
        'orchestrator',
        'run',
        '--issue',
        '1',
        '--executor',
        'bash',
        '--script',
        scriptPath,
      ]);

      const output = consoleErrorSpy.mock.calls.map((call) => String(call[0])).join('\n');
      expect(output).toContain('Run failed:');
      expect(output).toContain('Run UUID:');
      expect(output).toContain('Resume with: orchestrator runs resume --uuid');
      expect(output).not.toContain('--confirm');
    } finally {
      process.chdir(savedCwd);
    }
  }, 20000);
});
