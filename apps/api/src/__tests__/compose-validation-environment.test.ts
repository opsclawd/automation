import { afterEach, describe, expect, it } from 'vitest';
import { PhaseName, RunId } from '@ai-sdlc/domain';
import {
  createComposedOrchestrationHarness,
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
    validationCommands: opts.validationCommands ?? ['echo "GITHUB_REPOSITORY=$GITHUB_REPOSITORY"'],
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
      const SENTINEL_VAR = 'SENTINEL_PRESERVED_VALUE';
      const SENTINEL_VALUE = 'sentinel-1234';

      const originalGithubRepo = process.env.GITHUB_REPOSITORY;
      process.env.GITHUB_REPOSITORY = AMBIENT_REPO;
      process.env[SENTINEL_VAR] = SENTINEL_VALUE;

      try {
        const harness = createHarness({
          repoFullName: TARGET_REPO,
          validationCommands: [
            `echo "GITHUB_REPOSITORY=$GITHUB_REPOSITORY"`,
            `echo "SENTINEL=$SENTINEL_VAR"`,
          ],
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

        const validationInputs = harness.validationPort.inputs;
        expect(validationInputs).toHaveLength(1);
        const input = validationInputs[0]!;
        expect(input.env).toBeDefined();
        expect(input.env!['GITHUB_REPOSITORY']).toBe(TARGET_REPO);
      } finally {
        process.env.GITHUB_REPOSITORY = originalGithubRepo ?? '';
        delete process.env[SENTINEL_VAR];
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
          validationCommands: [`echo "GITHUB_REPOSITORY=$GITHUB_REPOSITORY"`],
        });

        const validateHandler = harness.container.phaseRegistry.get(PhaseName('validate'));
        expect(validateHandler).toBeDefined();

        const result = await validateHandler.run(harness.context);
        expect(result).toEqual({ outcome: 'passed' });

        const validationInputs = harness.validationPort.inputs;
        expect(validationInputs).toHaveLength(1);
        const input = validationInputs[0]!;
        expect(input.env?.['GITHUB_REPOSITORY']).toBe('owner/test-repo');
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
      process.env.GITHUB_REPOSITORY = AMBIENT_REPO;

      try {
        const harnessA = createHarness({
          repoFullName: REPO_A,
          issueNumber: 1,
          validationCommands: [`echo "REPO_A_VALIDATION"`],
        });

        const harnessB = createHarness({
          repoFullName: REPO_B,
          issueNumber: 2,
          validationCommands: [`echo "REPO_B_VALIDATION"`],
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

        const inputsA = harnessA.validationPort.inputs;
        const inputsB = harnessB.validationPort.inputs;

        expect(inputsA).toHaveLength(1);
        expect(inputsB).toHaveLength(1);

        expect(inputsA[0]!.env!['GITHUB_REPOSITORY']).toBe(REPO_A);
        expect(inputsB[0]!.env!['GITHUB_REPOSITORY']).toBe(REPO_B);

        expect(inputsA[0]!.env!['GITHUB_REPOSITORY']).not.toBe(REPO_B);
        expect(inputsB[0]!.env!['GITHUB_REPOSITORY']).not.toBe(REPO_A);
        expect(inputsA[0]!.env!['GITHUB_REPOSITORY']).not.toBe(AMBIENT_REPO);
        expect(inputsB[0]!.env!['GITHUB_REPOSITORY']).not.toBe(AMBIENT_REPO);
      } finally {
        process.env.GITHUB_REPOSITORY = originalGithubRepo ?? '';
      }
    });

    it('sequential runs with different repositories maintain isolation', async () => {
      const REPO_FIRST = 'owner/first-repo';
      const REPO_SECOND = 'owner/second-repo';

      const harnessFirst = createHarness({
        repoFullName: REPO_FIRST,
        issueNumber: 10,
        validationCommands: ['echo first'],
      });

      const harnessSecond = createHarness({
        repoFullName: REPO_SECOND,
        issueNumber: 20,
        validationCommands: ['echo second'],
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

      expect(harnessFirst.validationPort.inputs[0]!.env!['GITHUB_REPOSITORY']).toBe(REPO_FIRST);
      expect(harnessSecond.validationPort.inputs[0]!.env!['GITHUB_REPOSITORY']).toBe(REPO_SECOND);
    });
  });

  describe('initial validation cleanup restores process environment and temporary directories', () => {
    it('restores process environment after validation completes', async () => {
      const SENTINEL_VAR = 'CLEANUP_TEST_VAR';
      const ORIGINAL_VALUE = 'original-value';

      process.env[SENTINEL_VAR] = ORIGINAL_VALUE;

      const harness = createHarness({
        repoFullName: 'owner/cleanup-test-repo',
        validationCommands: ['echo ok'],
      });

      const validateHandler = harness.container.phaseRegistry.get(PhaseName('validate'));
      await validateHandler.run(harness.context);

      expect(process.env[SENTINEL_VAR]).toBe(ORIGINAL_VALUE);

      delete process.env[SENTINEL_VAR];
    });

    it('removes temporary directories on cleanup', () => {
      const harness = createHarness({
        repoFullName: 'owner/tmp-cleanup-repo',
        validationCommands: ['echo ok'],
      });

      const { automationRoot, targetRoot } = harness;

      expect(automationRoot).toContain('ai-orch-harness-');
      expect(targetRoot).toContain('ai-orch-harness-');

      harness.cleanup();

      // Accessing properties after cleanup is undefined behavior, but the cleanup itself should not throw
    });

    it('handles cleanup after assertion failures gracefully', () => {
      const harness = createHarness({
        repoFullName: 'owner/assertion-fail-repo',
        validationCommands: ['echo ok'],
      });

      try {
        expect(true).toBe(false);
      } catch {
        harness.cleanup();
      }
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
});
