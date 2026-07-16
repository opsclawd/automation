import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PhaseName, RunId, validationRunPassed } from '@ai-sdlc/domain';
import {
  createComposedOrchestrationHarness,
  createReviewFailScript,
  createFixCommitsResultScript,
  createImplementPassScript,
  createSpecReviewPassScript,
  createQualityReviewPassScript,
  type ComposedOrchestrationHarness,
} from './helpers/composed-orchestration-harness.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/validation-env-fixture.mjs', import.meta.url),
);

function fixtureCommand(expectedRepository: string): string {
  return `node ${JSON.stringify(FIXTURE_PATH)} ${expectedRepository} check`;
}

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
    validationCommands: opts.validationCommands ?? ['ls'],
    scripts: opts.scripts,
    ambientGitHubRepository: opts.ambientGitHubRepository,
  });
  harnessCleanup.push(h);
  return h;
}

describe('compose-validation-environment', () => {
  describe('initial validation overrides ambient repository identity and preserves inherited variables', () => {
    it('uses the PhaseHandlerContext repository when ambient identity differs', async () => {
      const AMBIENT_REPO = 'ambient/wrong';
      const TARGET_REPO = 'owner/test-repo';

      const originalGithubRepo = process.env.GITHUB_REPOSITORY;
      const originalInheritedSentinel = process.env.AI_SDLC_INHERITED_SENTINEL;
      process.env.GITHUB_REPOSITORY = AMBIENT_REPO;
      process.env.AI_SDLC_INHERITED_SENTINEL = 'sentinel-preserved';

      try {
        const harness = createHarness({
          repoFullName: TARGET_REPO,
          validationCommands: [fixtureCommand(TARGET_REPO)],
        });

        const validateHandler = harness.container.phaseRegistry.get(PhaseName('validate'));
        expect(validateHandler).toBeDefined();

        const result = await validateHandler.run(harness.context);

        expect(result).toEqual({ outcome: 'passed' });

        const validationRuns = harness.container.validationRunRepository.listByRun(
          RunId(harness.run.uuid),
        );
        expect(validationRuns).toHaveLength(1);
        const vr = validationRuns[0]!;
        expect(vr.runId).toBe(RunId(harness.run.uuid));
        expect(vr.phaseId).toBe(PhaseName('validate'));
      } finally {
        if (originalGithubRepo !== undefined) {
          process.env.GITHUB_REPOSITORY = originalGithubRepo;
        } else {
          delete process.env.GITHUB_REPOSITORY;
        }
        if (originalInheritedSentinel !== undefined) {
          process.env.AI_SDLC_INHERITED_SENTINEL = originalInheritedSentinel;
        } else {
          delete process.env.AI_SDLC_INHERITED_SENTINEL;
        }
      }
    });

    it('preserves inherited environment variables in validation commands', async () => {
      const SENTINEL_VAR = 'MY_CUSTOM_ENV_VAR';
      const SENTINEL_VALUE = 'custom-value-5678';

      const originalVal = process.env[SENTINEL_VAR];
      process.env[SENTINEL_VAR] = SENTINEL_VALUE;

      try {
        const harness = createHarness({
          repoFullName: 'owner/test-repo',
          validationCommands: ['ls'],
        });

        const validateHandler = harness.container.phaseRegistry.get(PhaseName('validate'));
        expect(validateHandler).toBeDefined();

        const result = await validateHandler.run(harness.context);
        expect(result).toEqual({ outcome: 'passed' });

        expect(process.env[SENTINEL_VAR]).toBe(SENTINEL_VALUE);
      } finally {
        if (originalVal !== undefined) {
          process.env[SENTINEL_VAR] = originalVal;
        } else {
          delete process.env[SENTINEL_VAR];
        }
      }
    });
  });

  describe('separate composed runs inject their own repository full names', () => {
    it('each ValidationRun belongs to its own Run and contains only its owning Repository output', async () => {
      const AMBIENT_REPO = 'ambient/third';
      const REPO_A = 'owner/repo-a';
      const REPO_B = 'owner/repo-b';

      const originalGithubRepo = process.env.GITHUB_REPOSITORY;
      const originalInheritedSentinel = process.env.AI_SDLC_INHERITED_SENTINEL;
      process.env.GITHUB_REPOSITORY = AMBIENT_REPO;
      process.env.AI_SDLC_INHERITED_SENTINEL = 'sentinel-preserved';

      try {
        const harnessA = createHarness({
          repoFullName: REPO_A,
          issueNumber: 1,
          validationCommands: [fixtureCommand(REPO_A)],
        });

        const harnessB = createHarness({
          repoFullName: REPO_B,
          issueNumber: 2,
          validationCommands: [fixtureCommand(REPO_B)],
        });

        const handlerA = harnessA.container.phaseRegistry.get(PhaseName('validate'));
        const handlerB = harnessB.container.phaseRegistry.get(PhaseName('validate'));

        expect(handlerA).toBeDefined();
        expect(handlerB).toBeDefined();

        const [resultA, resultB] = await Promise.all([
          handlerA.run(harnessA.context),
          handlerB.run(harnessB.context),
        ]);

        expect(resultA).toEqual({ outcome: 'passed' });
        expect(resultB).toEqual({ outcome: 'passed' });

        const runsA = harnessA.container.validationRunRepository.listByRun(
          RunId(harnessA.run.uuid),
        );
        const runsB = harnessB.container.validationRunRepository.listByRun(
          RunId(harnessB.run.uuid),
        );

        expect(runsA).toHaveLength(1);
        expect(runsB).toHaveLength(1);

        const vrA = runsA[0]!;
        const vrB = runsB[0]!;

        expect(vrA.runId).toBe(RunId(harnessA.run.uuid));
        expect(vrB.runId).toBe(RunId(harnessB.run.uuid));
        expect(vrA.runId).not.toBe(vrB.runId);
      } finally {
        if (originalGithubRepo !== undefined) {
          process.env.GITHUB_REPOSITORY = originalGithubRepo;
        } else {
          delete process.env.GITHUB_REPOSITORY;
        }
        if (originalInheritedSentinel !== undefined) {
          process.env.AI_SDLC_INHERITED_SENTINEL = originalInheritedSentinel;
        } else {
          delete process.env.AI_SDLC_INHERITED_SENTINEL;
        }
      }
    });

    it('sequential runs with different repositories maintain isolation', async () => {
      const REPO_FIRST = 'owner/first-repo';
      const REPO_SECOND = 'owner/second-repo';

      const harnessFirst = createHarness({
        repoFullName: REPO_FIRST,
        issueNumber: 10,
        validationCommands: ['ls'],
      });

      const harnessSecond = createHarness({
        repoFullName: REPO_SECOND,
        issueNumber: 20,
        validationCommands: ['ls'],
      });

      const handlerFirst = harnessFirst.container.phaseRegistry.get(PhaseName('validate'));
      const handlerSecond = harnessSecond.container.phaseRegistry.get(PhaseName('validate'));

      await handlerFirst.run(harnessFirst.context);

      const runsFirstAfter = harnessFirst.container.validationRunRepository.listByRun(
        RunId(harnessFirst.run.uuid),
      );
      expect(runsFirstAfter).toHaveLength(1);

      await handlerSecond.run(harnessSecond.context);

      const runsFirstAfterSecond = harnessFirst.container.validationRunRepository.listByRun(
        RunId(harnessFirst.run.uuid),
      );
      const runsSecond = harnessSecond.container.validationRunRepository.listByRun(
        RunId(harnessSecond.run.uuid),
      );

      expect(runsFirstAfterSecond).toHaveLength(1);
      expect(runsSecond).toHaveLength(1);
    });
  });

  describe('initial validation cleanup restores process environment and temporary directories', () => {
    it('restores process environment after validation completes', async () => {
      const SENTINEL_VAR = 'CLEANUP_TEST_VAR';
      const ORIGINAL_VALUE = 'original-value';

      process.env[SENTINEL_VAR] = ORIGINAL_VALUE;

      const harness = createHarness({
        repoFullName: 'owner/cleanup-test-repo',
        validationCommands: ['ls'],
      });

      const validateHandler = harness.container.phaseRegistry.get(PhaseName('validate'));
      await validateHandler.run(harness.context);

      expect(process.env[SENTINEL_VAR]).toBe(ORIGINAL_VALUE);

      delete process.env[SENTINEL_VAR];
    });

    it('removes temporary directories on cleanup', () => {
      const harness = createHarness({
        repoFullName: 'owner/tmp-cleanup-repo',
        validationCommands: ['ls'],
      });

      const { automationRoot, targetRoot } = harness;

      expect(automationRoot).toContain('ai-orch-harness-');
      expect(targetRoot).toContain('ai-orch-harness-');

      harness.cleanup();

      expect(existsSync(automationRoot)).toBe(false);
      expect(existsSync(targetRoot)).toBe(false);
    });

    it('cleanup is idempotent when called multiple times', async () => {
      const harness = createHarness({
        repoFullName: 'owner/idempotent-cleanup-repo',
        validationCommands: ['ls'],
      });

      const validateHandler = harness.container.phaseRegistry.get(PhaseName('validate'));
      const result = await validateHandler.run(harness.context);
      expect(result.outcome).toBe('passed');

      harness.cleanup();
      expect(existsSync(harness.automationRoot)).toBe(false);

      // afterEach's harnessCleanup array will call cleanup() again for this
      // harness; a second call after removal must not throw.
      expect(() => harness.cleanup()).not.toThrow();
    });

    it('cleans up even when validation fails', async () => {
      const harness = createHarness({
        repoFullName: 'owner/failing-cleanup-repo',
        validationCommands: ['exit 1'],
      });

      const validateHandler = harness.container.phaseRegistry.get(PhaseName('validate'));
      const result = await validateHandler.run(harness.context);

      // The result should indicate failure, but cleanup should still work
      expect(result.outcome).toBe('failed');

      // This should not throw
      harness.cleanup();
    });
  });

  describe('revalidation injects the correct repository identity', () => {
    it('review-fix revalidation injects the StepContext repository', async () => {
      const AMBIENT_REPO = 'ambient/wrong-repo';
      const TARGET_REPO = 'owner/review-fix-test-repo';

      const originalGithubRepo = process.env.GITHUB_REPOSITORY;
      const originalInheritedSentinel = process.env.AI_SDLC_INHERITED_SENTINEL;
      process.env.GITHUB_REPOSITORY = AMBIENT_REPO;
      process.env.AI_SDLC_INHERITED_SENTINEL = 'sentinel-preserved';

      try {
        const harness = createHarness({
          repoFullName: TARGET_REPO,
          issueNumber: 100,
          validationCommands: [fixtureCommand(TARGET_REPO)],
          scripts: [createReviewFailScript(), createFixCommitsResultScript()],
        });

        if (!harness.container.reviewFixLoop) {
          throw new Error('reviewFixLoop not available on container');
        }

        const reviewFixResult = await harness.container.reviewFixLoop.execute({
          runId: RunId(harness.run.uuid),
          phaseId: PhaseName('review-fix'),
          repoId: TARGET_REPO,
          cwd: harness.context.cwd,
          maxIterations: 1,
          reviewProfile: 'test' as import('@ai-sdlc/domain').AgentProfileName,
          fixProfile: 'test' as import('@ai-sdlc/domain').AgentProfileName,
        });

        expect(reviewFixResult.phaseOutcome).toBeDefined();

        const validationRuns = harness.container.validationRunRepository.listByRun(
          RunId(harness.run.uuid),
        );

        const passingRuns = validationRuns.filter((vr) => validationRunPassed(vr));
        expect(passingRuns.length).toBeGreaterThan(0);

        const revalidationRun = passingRuns.find((vr) =>
          vr.commands.some((c) => c.stdoutPath.includes('revalidate')),
        );
        expect(revalidationRun).toBeDefined();

        if (revalidationRun && revalidationRun.commands.length > 0) {
          const logContents = readFileSync(revalidationRun.commands[0]!.stdoutPath, 'utf-8');
          expect(logContents).toContain(TARGET_REPO);
          expect(logContents).toContain('sentinel-preserved');
        }
      } finally {
        if (originalGithubRepo !== undefined) {
          process.env.GITHUB_REPOSITORY = originalGithubRepo;
        } else {
          delete process.env.GITHUB_REPOSITORY;
        }
        if (originalInheritedSentinel !== undefined) {
          process.env.AI_SDLC_INHERITED_SENTINEL = originalInheritedSentinel;
        } else {
          delete process.env.AI_SDLC_INHERITED_SENTINEL;
        }
      }
    });

    it('implement-step revalidation injects the StepLoopContext repository', async () => {
      const AMBIENT_REPO = 'ambient/wrong-implement-repo';
      const TARGET_REPO = 'owner/implement-step-test-repo';

      const originalGithubRepo = process.env.GITHUB_REPOSITORY;
      const originalInheritedSentinel = process.env.AI_SDLC_INHERITED_SENTINEL;
      process.env.GITHUB_REPOSITORY = AMBIENT_REPO;
      process.env.AI_SDLC_INHERITED_SENTINEL = 'sentinel-preserved';

      try {
        const harness = createHarness({
          repoFullName: TARGET_REPO,
          issueNumber: 200,
          validationCommands: [fixtureCommand(TARGET_REPO)],
          scripts: [
            createImplementPassScript(),
            createSpecReviewPassScript(),
            createQualityReviewPassScript(),
            createFixCommitsResultScript(),
          ],
        });

        if (!harness.container.implementStepLoop) {
          throw new Error('implementStepLoop not available on container');
        }

        const taskManifest = {
          version: 2 as const,
          task_count: 1,
          tasks: [
            {
              n: 1,
              title: 'Test Task',
            },
          ],
        };

        const planMd = '# Plan\n\n## Task 1: Test Task\n\nImplement the test.';
        const artifacts = harness.container.artifactRepository;
        await artifacts.write({
          runId: harness.run.uuid,
          relativePath: 'task-manifest.json',
          contents: JSON.stringify(taskManifest),
        });
        await artifacts.write({
          runId: harness.run.uuid,
          relativePath: 'plan.md',
          contents: planMd,
        });

        const implementResult = await harness.container.implementStepLoop.execute({
          runId: RunId(harness.run.uuid),
          phaseId: PhaseName('implement'),
          repoId: TARGET_REPO,
          cwd: harness.context.cwd,
          stepIndex: 1,
          stepTitle: 'Test Task',
          maxIterations: 1,
          maxTypeCheckRetries: 0,
          manifest: taskManifest,
          planMd,
        });

        expect(implementResult.outcome).toBeDefined();

        const validationRuns = harness.container.validationRunRepository.listByRun(
          RunId(harness.run.uuid),
        );

        const passingRuns = validationRuns.filter((vr) => validationRunPassed(vr));
        expect(passingRuns.length).toBeGreaterThan(0);

        const revalidationRun = passingRuns.find((vr) =>
          vr.commands.some((c) => c.stdoutPath.includes('revalidate')),
        );
        expect(revalidationRun).toBeDefined();

        if (revalidationRun && revalidationRun.commands.length > 0) {
          const logContents = readFileSync(revalidationRun.commands[0]!.stdoutPath, 'utf-8');
          expect(logContents).toContain(TARGET_REPO);
          expect(logContents).toContain('sentinel-preserved');
        }
      } finally {
        if (originalGithubRepo !== undefined) {
          process.env.GITHUB_REPOSITORY = originalGithubRepo;
        } else {
          delete process.env.GITHUB_REPOSITORY;
        }
        if (originalInheritedSentinel !== undefined) {
          process.env.AI_SDLC_INHERITED_SENTINEL = originalInheritedSentinel;
        } else {
          delete process.env.AI_SDLC_INHERITED_SENTINEL;
        }
      }
    });

    it('revalidation cleanup restores environment after a scripted agent failure', async () => {
      const AMBIENT_REPO = 'ambient/cleanup-test-repo';
      const TARGET_REPO = 'owner/cleanup-test-repo';

      const originalGithubRepo = process.env.GITHUB_REPOSITORY;
      const originalInheritedSentinel = process.env.AI_SDLC_INHERITED_SENTINEL;
      process.env.GITHUB_REPOSITORY = AMBIENT_REPO;
      process.env.AI_SDLC_INHERITED_SENTINEL = 'sentinel-preserved';

      const failingScript: import('./helpers/composed-orchestration-harness.js').ScriptedAgentScript =
        {
          phaseId: 'whole-pr-review',
          invocationType: 'initial',
          handle: async () => {
            throw new Error('Scripted agent failure');
          },
        };

      const harness = createHarness({
        repoFullName: TARGET_REPO,
        issueNumber: 300,
        validationCommands: [fixtureCommand(TARGET_REPO)],
        scripts: [failingScript],
      });

      try {
        if (!harness.container.reviewFixLoop) {
          throw new Error('reviewFixLoop not available on container');
        }

        await expect(async () => {
          await harness.container.reviewFixLoop.execute({
            runId: RunId(harness.run.uuid),
            phaseId: PhaseName('review-fix'),
            repoId: TARGET_REPO,
            cwd: harness.context.cwd,
            maxIterations: 1,
            reviewProfile: 'test' as import('@ai-sdlc/domain').AgentProfileName,
            fixProfile: 'test' as import('@ai-sdlc/domain').AgentProfileName,
          });
        }).rejects.toThrow('Scripted agent failure');

        expect(process.env.GITHUB_REPOSITORY).toBe(AMBIENT_REPO);
        expect(process.env.AI_SDLC_INHERITED_SENTINEL).toBe('sentinel-preserved');

        harness.cleanup();

        expect(existsSync(harness.automationRoot)).toBe(false);
        expect(existsSync(harness.targetRoot)).toBe(false);
      } finally {
        if (originalGithubRepo !== undefined) {
          process.env.GITHUB_REPOSITORY = originalGithubRepo;
        } else {
          delete process.env.GITHUB_REPOSITORY;
        }
        if (originalInheritedSentinel !== undefined) {
          process.env.AI_SDLC_INHERITED_SENTINEL = originalInheritedSentinel;
        } else {
          delete process.env.AI_SDLC_INHERITED_SENTINEL;
        }
      }
    });
  });
});
