import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';

const mockBehavior = vi.hoisted(() => ({ reviewResult: 'pass' as 'pass' | 'fail' }));

vi.mock('@ai-sdlc/infrastructure', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@ai-sdlc/infrastructure')>();
  return {
    ...mod,
    OpenCodeAgentAdapter: class {
      async invoke(request: { cwd: string }) {
        const { writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const fail = mockBehavior.reviewResult === 'fail';
        writeFileSync(
          join(request.cwd, 'result.json'),
          JSON.stringify(
            fail
              ? { result: 'fail', findings: [{ severity: 'high', summary: 'stub' }] }
              : { result: 'pass', findings: [] },
          ),
        );
        writeFileSync(
          join(request.cwd, 'code-review.md'),
          fail ? '# Review failed\n' : '# Review passed\n',
        );
        return {
          runtime: 'opencode' as const,
          provider: 'test',
          model: 'test',
          exitCode: 0,
          durationMs: 10,
          stdoutPath: '',
          stderrPath: '',
          resultJsonPath: 'result.json',
          contractViolations: [],
          outcome: 'success' as const,
        };
      }
    },
  };
});

describe('run-review-fix integration', () => {
  let repoRoot: string;

  const baseConfig = {
    phases: {
      skip: [],
      reviewFix: { maxIterations: 10 },
      implement: { maxIterations: 5 },
    },
    timeouts: { readyMaxDays: 7, invocationMaxMinutes: 30 },
    validation: { commands: ['true'], timeout: 30 },
    agent: {
      defaultProfile: 'reviewer',
      profiles: {
        reviewer: {
          runtime: 'opencode' as const,
          provider: 'test',
          model: 'test',
          timeoutMinutes: 1,
        },
        fixer: {
          runtime: 'opencode' as const,
          provider: 'test',
          model: 'test',
          timeoutMinutes: 1,
        },
      },
      phaseProfiles: {
        'whole-pr-review': { profile: 'reviewer' },
        'fix-review': { profile: 'fixer' },
        validate: { profile: 'reviewer' },
      },
    },
  };

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'run-rf-int-'));
    // A real git repo, NOT a faked empty `.git` dir. The review-fix loop runs
    // `git rev-parse HEAD` in repoRoot, which needs a valid repository with a
    // commit. An empty `.git` only appears to work when the temp dir happens to
    // sit inside another repo (git walks up and finds it) — e.g. when an
    // orchestrator run nests TMPDIR under the checkout — but fails in a clean
    // CI tmpdir with `fatal: not a git repository`.
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoRoot });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
  });

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  async function compose() {
    writeFileSync(join(repoRoot, '.ai-orchestrator.json'), JSON.stringify(baseConfig, null, 2));
    const { composeRoot } = await import('@ai-sdlc/api/compose.js');
    return composeRoot({
      repoRoot,
      scriptPath: '/dev/null',
      dbPath: ':memory:',
      runStartupSweeps: false,
    });
  }

  it('converges when review passes on first iteration → exit 0', async () => {
    const c = await compose();
    expect(c.reviewFixLoop).toBeDefined();

    const runUuid = '00000000-0000-0000-0000-000000000d01';
    c.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: 'run-d01',
      issueNumber: 337,
      type: 'issue',
      status: 'running',
      completedPhases: [],
      startedAt: new Date(),
    } as never);

    const { phaseOutcome, loop } = await c.reviewFixLoop!.execute({
      runId: RunId(runUuid),
      phaseId: PhaseName('whole-pr-review'),
      repoId: 'test/test',
      cwd: repoRoot,
      maxIterations: 3,
      reviewProfile: AgentProfileName('reviewer'),
      fixProfile: AgentProfileName('fixer'),
    });

    // The mock returns a passing review result on every invocation, so the
    // loop converges on the first iteration. We verify that execute() returns
    // a phaseOutcome and that a loop row with at least one iteration is
    // persisted.
    expect(typeof phaseOutcome).toBe('string');
    expect(loop).toBeDefined();
    expect(typeof loop.status).toBe('string');
    // Verify a loop row was persisted
    const allLoops = c.loopRepository.listForRun(RunId(runUuid));
    expect(allLoops).toHaveLength(1);
    expect(allLoops[0].type).toBe('review-fix');
    expect(allLoops[0].iterations.length).toBeGreaterThanOrEqual(1);
  });

  it('exhausts when review never passes within maxIterations → exit 1', async () => {
    mockBehavior.reviewResult = 'fail';
    const c = await compose();
    expect(c.reviewFixLoop).toBeDefined();

    const runUuid = '00000000-0000-0000-0000-000000000d02';
    c.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: 'run-d02',
      issueNumber: 337,
      type: 'issue',
      status: 'running',
      completedPhases: [],
      startedAt: new Date(),
    } as never);

    const { phaseOutcome, loop } = await c.reviewFixLoop!.execute({
      runId: RunId(runUuid),
      phaseId: PhaseName('whole-pr-review'),
      repoId: 'test/test',
      cwd: repoRoot,
      maxIterations: 2,
      reviewProfile: AgentProfileName('reviewer'),
      fixProfile: AgentProfileName('fixer'),
    });

    expect(phaseOutcome).toBe('failed');
    expect(loop.status).toBe('exhausted');
    expect(loop.iterations.length).toBe(2);
  });
});
