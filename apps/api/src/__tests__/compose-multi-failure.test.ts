import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PhaseName, RunId } from '@ai-sdlc/domain';
import {
  createComposedOrchestrationHarness,
  createTwoFailureValidationCommands,
  createReviewFailScript,
  createFixCommitsResultScript,
  createReviewPassScript,
  createImplementPassScript,
  createSpecReviewFailScript,
  createQualityReviewFailScript,
  type ComposedOrchestrationHarness,
  type ScriptedAgentScript,
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

describe('multi-failure revalidation collection', () => {
  describe('review-fix revalidation reports every bounded failed command detail', () => {
    it('captures both failing commands in order in the persisted ValidationRun', async () => {
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

      // Wrap runRevalidation to capture failureDetail
      const loop = harness.container.reviewFixLoop as unknown as {
        deps: {
          runRevalidation: (ctx: unknown) => Promise<{ passed: boolean; failureDetail?: string }>;
        };
      };
      const originalRunRevalidation = loop.deps.runRevalidation;
      let capturedRevalResult: { passed: boolean; failureDetail?: string } | undefined;
      loop.deps.runRevalidation = async (ctx: unknown) => {
        const res = await originalRunRevalidation(ctx);
        capturedRevalResult = res;
        return res;
      };

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

      expect(capturedRevalResult).toBeDefined();
      expect(capturedRevalResult.passed).toBe(false);
      expect(capturedRevalResult.failureDetail).toBeDefined();
      const detail = capturedRevalResult.failureDetail;

      expect(detail).toContain(validationCommands[0]);
      expect(detail).toContain('\n\n---\n\n');
      expect(detail).toContain(validationCommands[1]);

      const firstDetailIndex = detail.indexOf(validationCommands[0]);
      const separatorIndex = detail.indexOf('\n\n---\n\n');
      const secondDetailIndex = detail.indexOf(validationCommands[1]);
      expect(firstDetailIndex).toBeLessThan(separatorIndex);
      expect(separatorIndex).toBeLessThan(secondDetailIndex);

      const stdoutParts = detail.split('Stdout:\n');
      const stderrParts = detail.split('Stderr:\n');

      const firstStdout = stdoutParts[1].split('Stderr:\n')[0];
      expect(firstStdout).toContain('TAIL_FIRST');
      expect(firstStdout).not.toContain('HEAD_ONLY_FIRST');

      const secondStderr = stderrParts[2] ?? stderrParts[1];
      expect(secondStderr).toContain('TAIL_SECOND');
      expect(secondStderr).not.toContain('HEAD_ONLY_SECOND');
    });
  });
});

describe('implement terminal prompt contains every bounded deterministic validation failure', () => {
  it('captures terminal prompt with bounded deterministic failure details in order', async () => {
    const validationCommands = createTwoFailureValidationCommands();

    let capturedTerminalPromptPath: string | undefined;

    const captureTerminalPromptScript: ScriptedAgentScript = {
      phaseId: 'fix-review',
      invocationType: 'terminal_fix',
      handle: async (request) => {
        capturedTerminalPromptPath = request.promptPath;
        const resultJson = JSON.stringify({ result: 'done_with_fixes' });
        writeFileSync(path.join(request.cwd, 'result.json'), resultJson, 'utf-8');
        return {
          runtime: 'test' as const,
          provider: 'test',
          model: 'test',
          exitCode: 0,
          durationMs: 10,
          stdoutPath: '/dev/null',
          stderrPath: '/dev/null',
          contractViolations: [],
          outcome: 'success' as const,
        };
      },
    };

    const harness = createHarness({
      repoFullName: 'owner/multi-fail-implement',
      issueNumber: 1,
      validationCommands,
      scripts: [
        createImplementPassScript(),
        createSpecReviewFailScript(),
        createQualityReviewFailScript(),
        captureTerminalPromptScript,
      ],
      agentConfig: {
        validation: { commands: validationCommands, timeout: 60 },
        phases: {
          skip: [],
          reviewFix: { maxIterations: 1 },
          implement: { maxIterations: 1 },
          fixValidate: { enabled: false, maxIterations: 3 },
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
            implement: { profile: 'test' },
            'spec-review': { profile: 'test' },
            'quality-review': { profile: 'test' },
            'terminal-fix': { profile: 'test' },
          },
        },
      },
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

    const implementResult = await harness.container.implementStepLoop.execute({
      runId: RunId(harness.run.uuid),
      phaseId: PhaseName('implement'),
      repoId: 'owner/multi-fail-implement',
      cwd: harness.context.cwd,
      stepIndex: 1,
      stepTitle: 'Test Task',
      maxIterations: 1,
      maxTypeCheckRetries: 0,
      manifest: taskManifest,
      planMd,
    });

    expect(implementResult.outcome).toBeDefined();

    expect(capturedTerminalPromptPath).toBeDefined();
    if (!capturedTerminalPromptPath) return;

    const promptContent = readFileSync(capturedTerminalPromptPath, 'utf-8');

    expect(promptContent).toContain('## DETERMINISTIC VERIFICATION FAILURES — MUST BE FIXED');
    expect(promptContent).toContain(validationCommands[0]);
    expect(promptContent).toContain('\n\n---\n\n');
    expect(promptContent).toContain(validationCommands[1]);

    const headingIndex = promptContent.indexOf(
      '## DETERMINISTIC VERIFICATION FAILURES — MUST BE FIXED',
    );
    const firstCmdIndex = promptContent.indexOf(validationCommands[0]);
    const separatorIndex = promptContent.indexOf('\n\n---\n\n');
    const secondCmdIndex = promptContent.indexOf(validationCommands[1]);
    expect(headingIndex).toBeLessThan(firstCmdIndex);
    expect(firstCmdIndex).toBeLessThan(separatorIndex);
    expect(separatorIndex).toBeLessThan(secondCmdIndex);

    const stdoutParts = promptContent.split('Stdout:\n');
    const stderrParts = promptContent.split('Stderr:\n');

    const firstStdout = stdoutParts[1].split('Stderr:\n')[0];
    expect(firstStdout).toContain('TAIL_FIRST');
    expect(firstStdout).not.toContain('HEAD_ONLY_FIRST');

    const secondStderr = stderrParts[2] ?? stderrParts[1];
    expect(secondStderr).toContain('TAIL_SECOND');
    expect(secondStderr).not.toContain('HEAD_ONLY_SECOND');
  });
});
