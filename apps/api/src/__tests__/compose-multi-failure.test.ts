import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PhaseName, RunId } from '@ai-sdlc/domain';
import {
  createComposedOrchestrationHarness,
  createTwoFailureValidationCommands,
  createReviewFailScript,
  createFixCommitsResultScript,
  createReviewPassScript,
  type ComposedOrchestrationHarness,
} from './helpers/composed-orchestration-harness.js';

const harnessCleanup: ComposedOrchestrationHarness[] = [];

afterEach(() => {
  for (const h of harnessCleanup) {
    h.cleanup();
  }
  harnessCleanup.length = 0;
});

function createHarness(opts: Parameters<typeof createComposedOrchestrationHarness>[0] = {}) {
  const h = createComposedOrchestrationHarness({
    repoFullName: opts.repoFullName ?? 'owner/test-repo',
    issueNumber: opts.issueNumber ?? 1,
    validationCommands: opts.validationCommands,
    scripts: opts.scripts,
    agentConfig: opts.agentConfig,
  });
  harnessCleanup.push(h);
  return h;
}

function findRevalidationDir(runsDir: string, runDisplayId: string): string | undefined {
  const revalidateBase = path.join(runsDir, runDisplayId, 'revalidate');
  if (!existsSync(revalidateBase)) return undefined;

  try {
    const loopDirs = readdirSync(revalidateBase, { withFileTypes: true });
    for (const loopEntry of loopDirs) {
      if (!loopEntry.isDirectory()) continue;
      const loopPath = path.join(revalidateBase, loopEntry.name);
      try {
        const phaseDirs = readdirSync(loopPath, { withFileTypes: true });
        for (const phaseEntry of phaseDirs) {
          if (!phaseEntry.isDirectory()) continue;
          const phasePath = path.join(loopPath, phaseEntry.name);
          try {
            const iterDirs = readdirSync(phasePath, { withFileTypes: true });
            for (const iterEntry of iterDirs) {
              if (!iterEntry.isDirectory()) continue;
              const iterPath = path.join(phasePath, iterEntry.name);
              const validateDir = path.join(iterPath, 'validate');
              if (existsSync(validateDir)) {
                return validateDir;
              }
              return iterPath;
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return undefined;
}

function readCommandOutput(
  runsDir: string,
  runDisplayId: string,
  stdoutPath: string,
  stderrPath: string,
): { stdout: string; stderr: string } {
  const revalidateDir = findRevalidationDir(runsDir, runDisplayId);
  if (!revalidateDir) return { stdout: '', stderr: '' };

  const stdoutFull = path.join(revalidateDir, path.basename(stdoutPath));
  const stderrFull = path.join(revalidateDir, path.basename(stderrPath));

  let stdout = '';
  let stderr = '';

  try {
    if (existsSync(stdoutFull)) {
      stdout = readFileSync(stdoutFull, 'utf-8');
    }
  } catch {}

  try {
    if (existsSync(stderrFull)) {
      stderr = readFileSync(stderrFull, 'utf-8');
    }
  } catch {}

  return { stdout, stderr };
}

function buildFailureDetailFromValidationRun(
  runsDir: string,
  runDisplayId: string,
  vr: {
    commands: Array<{ command: string; outcome: string; stdoutPath: string; stderrPath: string }>;
  },
): string {
  const failingCommands = vr.commands.filter((c) => c.outcome !== 'passed');
  const details: string[] = [];

  for (const c of failingCommands) {
    const { stdout, stderr } = readCommandOutput(runsDir, runDisplayId, c.stdoutPath, c.stderrPath);
    details.push(
      `Command: ${c.command}\nOutcome: ${c.outcome}\n\nStdout:\n${stdout}\n\nStderr:\n${stderr}`,
    );
  }

  return details.join('\n\n---\n\n');
}

describe('multi-failure revalidation collection', () => {
  describe('review-fix revalidation reports every bounded failed command detail', () => {
    it('captures both failing command tails in order', async () => {
      const validationCommands = createTwoFailureValidationCommands();

      const harness = createHarness({
        repoFullName: 'owner/multi-fail-review',
        issueNumber: 1,
        validationCommands,
        scripts: [
          createReviewFailScript(),
          createFixCommitsResultScript(),
          createReviewPassScript(),
        ],
      });

      if (!harness.container.reviewFixLoop) {
        throw new Error('reviewFixLoop not available on container');
      }

      const reviewFixResult = await harness.container.reviewFixLoop.execute({
        runId: RunId(harness.run.uuid),
        phaseId: PhaseName('review-fix'),
        repoId: 'owner/multi-fail-review',
        cwd: harness.context.cwd,
        maxIterations: 1,
        reviewProfile: 'test' as import('@ai-sdlc/domain').AgentProfileName,
        fixProfile: 'test' as import('@ai-sdlc/domain').AgentProfileName,
      });

      expect(reviewFixResult.phaseOutcome).toBeDefined();

      const validationRuns = harness.container.validationRunRepository.listByRun(
        RunId(harness.run.uuid),
      );
      expect(validationRuns.length).toBeGreaterThan(0);

      const failingRuns = validationRuns.filter(
        (vr) => !vr.commands.every((c) => c.outcome === 'passed'),
      );
      expect(failingRuns.length).toBeGreaterThan(0);

      const lastFailingRun = failingRuns[failingRuns.length - 1]!;
      const failedCommands = lastFailingRun.commands.filter((c) => c.outcome !== 'passed');
      expect(failedCommands).toHaveLength(2);
      expect(failedCommands[0]!.command).toContain('FIRST');
      expect(failedCommands[1]!.command).toContain('SECOND');

      const failureDetail = buildFailureDetailFromValidationRun(
        harness.container.runsDir,
        harness.run.displayId,
        lastFailingRun,
      );

      expect(failureDetail).toContain('TAIL_FIRST');
      expect(failureDetail).toContain('TAIL_SECOND');
      expect(failureDetail).toContain('\n\n---\n\n');
      expect(failureDetail.indexOf('TAIL_FIRST')).toBeLessThan(
        failureDetail.indexOf('TAIL_SECOND'),
      );
    });
  });
});
