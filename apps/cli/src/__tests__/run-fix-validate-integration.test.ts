import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';

const mockBehavior = vi.hoisted(() => ({
  fixResult: 'done_with_fixes' as 'done_with_fixes' | 'cannot_fix',
}));

vi.mock('@ai-sdlc/infrastructure', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-sdlc/infrastructure')>();
  return {
    ...mod,
    OpenCodeAgentAdapter: class {
      async invoke(request: { cwd: string }) {
        const { writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { execFileSync } = await import('node:child_process');
        writeFileSync(
          join(request.cwd, 'result.json'),
          JSON.stringify({
            result: mockBehavior.fixResult,
          }),
        );
        if (mockBehavior.fixResult === 'done_with_fixes') {
          writeFileSync(join(request.cwd, 'src/fix.ts'), '// fixed\n');
          execFileSync('git', ['add', '-A'], { cwd: request.cwd });
          execFileSync('git', ['commit', '-qm', 'fix: test fix'], { cwd: request.cwd });
        }
        const endCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: request.cwd,
        })
          .toString()
          .trim();
        return {
          runtime: 'opencode' as const,
          provider: 'test',
          model: 'test',
          exitCode: 0,
          durationMs: 10,
          stdoutPath: '',
          stderrPath: '',
          resultJsonPath: 'result.json',
          endCommitSha,
          contractViolations: [],
          outcome: 'success' as const,
        };
      }
    },
  };
});

describe('run-fix-validate integration', { timeout: 20_000 }, () => {
  let repoRoot: string;

  const baseConfig = {
    phases: {
      skip: [],
      reviewFix: { maxIterations: 10 },
      implement: { maxIterations: 5 },
      fixValidate: { maxIterations: 3, enabled: true },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
    validation: { commands: ['true'], timeout: 30 },
    agent: {
      defaultProfile: 'fixer',
      profiles: {
        fixer: {
          runtime: 'opencode' as const,
          provider: 'test',
          model: 'test',
          timeoutMinutes: 1,
        },
      },
      phaseProfiles: {
        'fix-validate': { profile: 'fixer' },
      },
    },
  };

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'run-fv-int-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src/fix.ts'), '// initial\n');
    writeFileSync(
      join(repoRoot, '.gitignore'),
      '/result.json\n.ai-runs/\n.ai-tmp/\n*.result\n*.log\n',
    );
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(repoRoot, '.ai-orchestrator.json'), JSON.stringify(baseConfig, null, 2));
    writeFileSync(
      join(repoRoot, 'task-manifest.json'),
      JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Fix issue',
            expected_files: ['src/fix.ts'],
          },
        ],
      }),
    );
    git('add', '-A');
    git('commit', '-qm', 'init');
  });

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function compose() {
    const { composeRoot } = await import('@ai-sdlc/api/compose.js');
    return composeRoot({
      repoRoot,
      scriptPath: '/dev/null',
      dbPath: ':memory:',
      runStartupSweeps: false,
    });
  }

  it('converges when fix agent reports fixed and revalidation passes', async () => {
    mockBehavior.fixResult = 'done_with_fixes';
    const c = await compose();
    expect(c.validateFixLoop).toBeDefined();

    const runUuid = '00000000-0000-0000-0000-000000000e01';
    c.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: 'run-e01',
      issueNumber: 337,
      type: 'issue',
      status: 'running',
      startedAt: new Date(),
      completedPhases: [] as string[],
      skippedPhases: [] as string[],
      displayIdHistory: [] as string[],
    });

    const { phaseOutcome, loop } = await c.validateFixLoop!.execute({
      runId: RunId(runUuid),
      phaseId: PhaseName('fix-validate'),
      repoId: 'test/test',
      cwd: repoRoot,
      maxIterations: 3,
      fixProfile: AgentProfileName('fixer'),
    });

    expect(phaseOutcome).toBe('passed');
    expect(loop.status).toBe('converged');
    expect(loop.iterations.length).toBeGreaterThanOrEqual(1);

    const allLoops = c.loopRepository.listForRun(RunId(runUuid));
    expect(allLoops).toHaveLength(1);
    expect(allLoops[0].type).toBe('validate-fix');
  });

  it('exhausts when fix agent always reports cannot_fix', async () => {
    mockBehavior.fixResult = 'cannot_fix';
    const c = await compose();
    expect(c.validateFixLoop).toBeDefined();

    const runUuid = '00000000-0000-0000-0000-000000000e02';
    c.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: 'run-e02',
      issueNumber: 337,
      type: 'issue',
      status: 'running',
      startedAt: new Date(),
      completedPhases: [] as string[],
      skippedPhases: [] as string[],
      displayIdHistory: [] as string[],
    });

    const { phaseOutcome, loop } = await c.validateFixLoop!.execute({
      runId: RunId(runUuid),
      phaseId: PhaseName('fix-validate'),
      repoId: 'test/test',
      cwd: repoRoot,
      maxIterations: 2,
      fixProfile: AgentProfileName('fixer'),
    });

    expect(phaseOutcome).toBe('failed');
    expect(loop.status).toBe('exhausted');
    expect(loop.iterations).toHaveLength(2);
  });
});
