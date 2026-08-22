import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ImplementHandler } from '@ai-sdlc/application';
import type { StepRunContext, StepRunResult, PhaseHandlerContext } from '@ai-sdlc/application';
import { FakeArtifactStore, FakeStepRepository } from '@ai-sdlc/application/test-doubles';
import { GitWorktreeAdapter } from '@ai-sdlc/infrastructure';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  vi.restoreAllMocks();
});

function trackDir(dir: string): string {
  tempDirs.push(dir);
  return dir;
}

describe('ImplementHandler protected files integration', () => {
  it('reverts an undeclared .gitignore inversion before auto-committed artifacts can remain in the step history', async () => {
    const repoDir = trackDir(mkdtempSync(join(tmpdir(), 'impl-protected-files-')));

    // Initialize temporary git repository
    execFileSync('git', ['init', '--quiet', '--initial-branch=main', repoDir], { stdio: 'pipe' });
    execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'], {
      stdio: 'pipe',
    });
    execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Test User'], { stdio: 'pipe' });

    // Seed baseline .gitignore and initial commit
    const baselineGitignore = [
      '# Orchestrator run artifacts',
      '/task-manifest.json',
      '/design.md',
      '/plan.md',
      '/prompt.md',
      '/implementation-log.md',
      '/result.json',
      '/plan-review-findings.md',
      '/plan-fix-result.json',
      '',
    ].join('\n');

    writeFileSync(join(repoDir, '.gitignore'), baselineGitignore);
    writeFileSync(join(repoDir, 'README.md'), '# Test Repository\n');
    execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' });
    execFileSync('git', ['-C', repoDir, 'commit', '--quiet', '-m', 'chore: initial commit'], {
      stdio: 'pipe',
    });

    // Create ignored orchestrator artifacts in worktree root
    writeFileSync(join(repoDir, 'design.md'), '# Design Document\n');
    writeFileSync(join(repoDir, 'task-manifest.json'), '{"version": 2, "task_count": 1}\n');
    writeFileSync(join(repoDir, 'plan-review-findings.md'), '# Findings\n');
    writeFileSync(join(repoDir, 'result.json'), '{"outcome": "passed"}\n');

    // Confirm initial state is clean and artifacts are untracked / ignored
    const initialStatus = execFileSync('git', ['-C', repoDir, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(initialStatus.trim()).toBe('');

    const initialTracked = execFileSync('git', ['-C', repoDir, 'ls-files', '-z'], {
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
    expect(initialTracked).not.toContain('design.md');
    expect(initialTracked).not.toContain('task-manifest.json');
    expect(initialTracked).not.toContain('plan-review-findings.md');
    expect(initialTracked).not.toContain('result.json');

    const preStepHead = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();

    // Set up artifact store with plan and task manifest
    const artifacts = new FakeArtifactStore();
    const steps = new FakeStepRepository();
    const runUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const planMd = [
      '# Plan',
      '',
      '## Task 1: Define the transition-soak evidence contract',
      'Implement the evidence contract.',
      '',
    ].join('\n');

    const manifest = {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1: Define the transition-soak evidence contract',
          expected_files: ['packages/contracts/src/transition-soak.ts'],
        },
      ],
    };

    await artifacts.write({ runId: runUuid, relativePath: 'plan.md', contents: planMd });
    await artifacts.write({
      runId: runUuid,
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(manifest),
    });

    const gitAdapter = new GitWorktreeAdapter();
    const events: OrchestratorEvent[] = [];

    const ctx: PhaseHandlerContext = {
      runId: 'run-1',
      runUuid,
      repoFullName: 'acme/repo',
      issueNumber: 1,
      cwd: repoDir,
      artifacts,
      github: {} as PhaseHandlerContext['github'],
      git: gitAdapter,
      agent: {} as PhaseHandlerContext['agent'],
      events: {
        publish: (_u: string, e: OrchestratorEvent) => {
          events.push(e);
        },
        subscribe: () => () => {},
      },
      now: () => new Date('2026-08-16T12:00:00Z'),
      idFactory: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
    };

    let attempt = 0;
    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      attempt++;
      if (attempt === 1) {
        // Step attempt 1: Create declared file
        mkdirSync(join(repoDir, 'packages/contracts/src'), { recursive: true });
        writeFileSync(
          join(repoDir, 'packages/contracts/src/transition-soak.ts'),
          'export const transitionSoak = true;\n',
        );

        // Invert .gitignore rules (undeclared edit)
        writeFileSync(
          join(repoDir, '.gitignore'),
          [
            '# Unignore orchestrator files so git add pathspecs with negative exclusions work',
            '!/task-manifest.json',
            '!/design.md',
            '!/plan-review-findings.md',
            '!/result.json',
            '',
          ].join('\n'),
        );

        // Commit declared file + modified .gitignore
        execFileSync(
          'git',
          ['-C', repoDir, 'add', 'packages/contracts/src/transition-soak.ts', '.gitignore'],
          {
            stdio: 'pipe',
          },
        );
        execFileSync(
          'git',
          ['-C', repoDir, 'commit', '--quiet', '-m', 'feat: implement task 1 and invert gitignore'],
          {
            stdio: 'pipe',
          },
        );

        // Simulate auto-commit sweep of newly visible un-ignored artifacts
        execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'pipe' });
        execFileSync(
          'git',
          [
            '-C',
            repoDir,
            'commit',
            '--quiet',
            '-m',
            'auto-committed — agent left changes uncommitted',
          ],
          { stdio: 'pipe' },
        );

        return { outcome: 'success' };
      }

      if (attempt === 2) {
        // Step attempt 2 (retry): Leave already-correct declared work untouched
        return { outcome: 'success' };
      }

      return { outcome: 'failed', failureMessage: 'unexpected attempt' };
    });

    // Test-local repair function
    const testRepairScopeFiles = async (input: {
      cwd: string;
      baseline: string;
      expectedHeadSha: string;
      rewriteSafety: 'unpublished';
      scopeFiles: readonly string[];
    }) => {
      execFileSync(
        'git',
        ['-C', input.cwd, 'checkout', input.baseline, '--', ...input.scopeFiles],
        {
          stdio: 'pipe',
        },
      );
      const ignored = execFileSync(
        'git',
        ['-C', input.cwd, 'ls-files', '-i', '-c', '--exclude-standard', '-z'],
        {
          encoding: 'utf8',
        },
      )
        .split('\0')
        .filter(Boolean);
      if (ignored.length > 0) {
        execFileSync('git', ['-C', input.cwd, 'rm', '--cached', '--', ...ignored], {
          stdio: 'pipe',
        });
      }
      execFileSync('git', ['-C', input.cwd, 'commit', '--amend', '--no-edit'], { stdio: 'pipe' });
      const amendedHeadSha = execFileSync('git', ['-C', input.cwd, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      return {
        revertedScopeFiles: [...input.scopeFiles],
        removedNewlyIgnoredFiles: ignored,
        amendedHeadSha,
      };
    };

    const handler = new ImplementHandler({
      steps,
      runStep,
      maxDeclaredFilesRetries: 1,
      revertScopeFiles: testRepairScopeFiles,
    });

    const result = await handler.run(ctx);

    // Assert the desired end state:
    // 1. Handler passes after one boundary retry
    expect(result.outcome).toBe('passed');

    // 2. .gitignore equals its baseline content
    expect(readFileSync(join(repoDir, '.gitignore'), 'utf8')).toBe(baselineGitignore);

    // 3. Step's cumulative diff contains only the declared source file
    const changedFiles = await gitAdapter.changedFiles(repoDir, preStepHead);
    expect(changedFiles).toEqual(['packages/contracts/src/transition-soak.ts']);

    // 4. Artifacts are absent from git ls-files but still exist and are ignored
    const trackedFiles = execFileSync('git', ['-C', repoDir, 'ls-files', '-z'], {
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
    expect(trackedFiles).toContain('packages/contracts/src/transition-soak.ts');
    expect(trackedFiles).toContain('.gitignore');
    expect(trackedFiles).not.toContain('design.md');
    expect(trackedFiles).not.toContain('task-manifest.json');
    expect(trackedFiles).not.toContain('plan-review-findings.md');
    expect(trackedFiles).not.toContain('result.json');

    expect(existsSync(join(repoDir, 'design.md'))).toBe(true);
    expect(existsSync(join(repoDir, 'task-manifest.json'))).toBe(true);
    expect(existsSync(join(repoDir, 'plan-review-findings.md'))).toBe(true);
    expect(existsSync(join(repoDir, 'result.json'))).toBe(true);

    const postStatus = execFileSync('git', ['-C', repoDir, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    expect(postStatus.trim()).toBe('');

    // 5. Retry diagnostic names .gitignore as the cause
    const retryEvents = events.filter((e) => e.type === 'step.declared_files_retry');
    expect(retryEvents).toHaveLength(1);
    const retryDiagnostic = JSON.stringify(retryEvents[0]);
    expect(retryDiagnostic).toContain('.gitignore');
  });
});
