import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RunId } from '@ai-sdlc/domain';
import { FixValidateHandler } from '../fix-validate.js';
import { ValidateHandler } from '../validate.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import type { RunValidation } from '../../../run-validation.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

const { mockLoadPromptTemplate, mockRenderPrompt } = vi.hoisted(() => ({
  mockLoadPromptTemplate: vi.fn(() => '# Template\n'),
  mockRenderPrompt: vi.fn(async () => '# Prompt\n'),
}));

vi.mock('../../../prompts/load-prompt-template.js', () => ({
  loadPromptTemplate: mockLoadPromptTemplate,
}));

vi.mock('../../../prompts/render-prompt.js', () => ({
  renderPrompt: mockRenderPrompt,
}));

const RUN_UUID = '550e8400-e29b-41d4-a716-446655440000';

function makeCtx(opts: { withFailureJson?: boolean } = {}) {
  const events: OrchestratorEvent[] = [];
  const artifacts = new FakeArtifactStore();
  if (opts.withFailureJson) {
    void artifacts.write({
      runId: RUN_UUID,
      phaseId: 'validate',
      relativePath: 'validate/failure.json',
      contents: JSON.stringify({ phase: 'validate', message: 'build failed' }),
    });
  }
  const ctx = {
    runId: 'human-readable-run',
    runUuid: RUN_UUID,
    repoFullName: 'acme/widgets',
    issueNumber: 7,
    cwd: '/tmp/wt',
    artifacts,
    github: {} as PhaseHandlerContext['github'],
    git: {} as PhaseHandlerContext['git'],
    agent: {} as PhaseHandlerContext['agent'],
    events: {
      publish: (_u: string, e: OrchestratorEvent) => {
        events.push(e);
      },
      subscribe: () => () => {},
    },
    now: () => new Date('2026-06-26T00:00:00Z'),
  } satisfies PhaseHandlerContext;
  return { ctx, events, artifacts };
}

async function setupLeanCtx(
  opts: {
    failure?: unknown;
    failureRaw?: string;
    artifacts?: Array<{ path: string; contents: string }>;
    sharedArtifacts?: FakeArtifactStore;
  } = {},
) {
  const { ctx, events } = makeCtx();
  const artifacts = opts.sharedArtifacts ?? ctx.artifacts;
  ctx.artifacts = artifacts;
  ctx.executionPolicy = 'standard';
  ctx.promptsRoot = '/tmp';
  ctx.startCommitSha = '0'.repeat(40);
  ctx.expectedBranch = 'ai/issue-7';

  if (opts.failureRaw !== undefined) {
    await artifacts.write({
      runId: RUN_UUID,
      phaseId: 'validate',
      relativePath: 'validate/failure.json',
      contents: opts.failureRaw,
    });
  } else if (opts.failure !== undefined) {
    await artifacts.write({
      runId: RUN_UUID,
      phaseId: 'validate',
      relativePath: 'validate/failure.json',
      contents: JSON.stringify(opts.failure),
    });
  }

  if (opts.artifacts) {
    for (const a of opts.artifacts) {
      await artifacts.write({
        runId: RUN_UUID,
        phaseId: 'validate',
        relativePath: a.path,
        contents: a.contents,
      });
    }
  }

  const fakeGit = new FakeGitPort();
  fakeGit.currentBranchByCwd.set('/tmp/wt', 'ai/issue-7');
  fakeGit.headByCwd.set('/tmp/wt', '0'.repeat(40));
  (ctx as { git: unknown }).git = fakeGit;

  const fakeAgent = {
    invoke: async () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 500,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'fix-validate-result.json',
      contractViolations: [],
      outcome: 'success' as const,
    }),
  };
  (ctx as { agent: unknown }).agent = fakeAgent;
  (ctx as { resolveProfile: unknown }).resolveProfile = () => 'opencode-frontier';
  (ctx as { idFactory: unknown }).idFactory = () => 'inv-1';

  return { ctx, events, artifacts, git: fakeGit };
}

beforeEach(() => {
  mockRenderPrompt.mockClear();
  mockLoadPromptTemplate.mockClear();
});

describe('FixValidateHandler', () => {
  it('returns passed immediately when validate/failure.json is absent (validate passed)', async () => {
    let loopCalled = false;
    const runLoop = async () => {
      loopCalled = true;
      return { phaseOutcome: 'passed' as const, loopStatus: 'converged' as const };
    };
    const { ctx, events } = makeCtx(); // no withFailureJson
    const result = await new FixValidateHandler({ runLoop }).run(ctx);
    expect(result.outcome).toBe('passed');
    expect(loopCalled).toBe(false);
    const skipped = events.filter((e) => e.type === 'fix_validate.skipped');
    expect(skipped).toHaveLength(1);
  });

  it('returns passed when the loop converges', async () => {
    const runLoop = async () => ({
      phaseOutcome: 'passed' as const,
      loopStatus: 'converged' as const,
    });
    const { ctx } = makeCtx({ withFailureJson: true });
    const result = await new FixValidateHandler({ runLoop }).run(ctx);
    expect(result.outcome).toBe('passed');
  });

  it('returns failed with validation_failed when the loop exhausts', async () => {
    const runLoop = async () => ({
      phaseOutcome: 'failed' as const,
      loopStatus: 'exhausted' as const,
    });
    const { ctx } = makeCtx({ withFailureJson: true });
    const result = await new FixValidateHandler({ runLoop }).run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('validation_failed');
      expect(result.failure.message).toBe('validate/fix loop exhausted without converging');
      expect(result.failure.phase).toBe('fix-validate');
      expect(result.failure.canRetry).toBe(true);
      expect(result.failure.runUuid).toBe(RUN_UUID);
    }
  });

  it('returns failed with validation_failed when the loop fails on agent error', async () => {
    const runLoop = async () => ({
      phaseOutcome: 'failed' as const,
      loopStatus: 'failed' as const,
    });
    const { ctx } = makeCtx({ withFailureJson: true });
    const result = await new FixValidateHandler({ runLoop }).run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('validation_failed');
      expect(result.failure.message).toBe('validate/fix loop failed');
      expect(result.failure.phase).toBe('fix-validate');
      expect(result.failure.canRetry).toBe(true);
    }
  });

  describe('event emission', () => {
    it('emits fix_validate.started and fix_validate.completed on convergence', async () => {
      const runLoop = async () => ({
        phaseOutcome: 'passed' as const,
        loopStatus: 'converged' as const,
      });
      const { ctx, events } = makeCtx({ withFailureJson: true });
      await new FixValidateHandler({ runLoop }).run(ctx);

      const started = events.filter((e) => e.type === 'fix_validate.started');
      expect(started).toHaveLength(1);
      expect(started[0].runId).toBe('human-readable-run');
      expect(started[0].level).toBe('info');
      expect(started[0].phase).toBe('fix-validate');

      const completed = events.filter((e) => e.type === 'fix_validate.completed');
      expect(completed).toHaveLength(1);
      expect(completed[0].level).toBe('info');
      expect(completed[0].phase).toBe('fix-validate');
    });

    it('emits fix_validate.started and fix_validate.failed on exhaustion', async () => {
      const runLoop = async () => ({
        phaseOutcome: 'failed' as const,
        loopStatus: 'exhausted' as const,
      });
      const { ctx, events } = makeCtx({ withFailureJson: true });
      await new FixValidateHandler({ runLoop }).run(ctx);

      const started = events.filter((e) => e.type === 'fix_validate.started');
      expect(started).toHaveLength(1);

      const failed = events.filter((e) => e.type === 'fix_validate.failed');
      expect(failed).toHaveLength(1);
      expect(failed[0].message).toBe('fix-validate loop exhausted');
    });

    it('returns a failure when runLoop throws', async () => {
      const runLoop = async () => {
        throw new Error('DB write failed');
      };
      const { ctx, events } = makeCtx({ withFailureJson: true });
      const result = await new FixValidateHandler({ runLoop }).run(ctx);

      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.failure.kind).toBe('unknown');
        expect(result.failure.message).toBe('validate/fix loop threw: DB write failed');
        expect(result.failure.phase).toBe('fix-validate');
        expect(result.failure.canRetry).toBe(true);
      }

      const failed = events.filter((e) => e.type === 'fix_validate.failed');
      expect(failed).toHaveLength(1);
    });

    it('does not emit fix_validate.completed on exhaustion', async () => {
      const runLoop = async () => ({
        phaseOutcome: 'failed' as const,
        loopStatus: 'exhausted' as const,
      });
      const { ctx, events } = makeCtx({ withFailureJson: true });
      await new FixValidateHandler({ runLoop }).run(ctx);
      const completed = events.filter((e) => e.type === 'fix_validate.completed');
      expect(completed).toHaveLength(0);
    });
  });
});

describe('fix-validate records the validated commit', () => {
  it('writes validation.headsha when the loop converges', async () => {
    // validate deferred here instead of passing, so it never wrote a headsha.
    // Without this, create-pr reads `(missing)` and blocks a converged run.
    const { ctx, artifacts } = makeCtx({ withFailureJson: true });
    (ctx as { git: unknown }).git = {
      headCommitSha: async () => 'abc123def456\n',
    } as PhaseHandlerContext['git'];

    const handler = new FixValidateHandler({
      runLoop: async () => ({ phaseOutcome: 'passed' as const, loopStatus: 'converged' as const }),
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');
    expect((await artifacts.read(RUN_UUID, 'validation.headsha')).trim()).toBe('abc123def456');
  });

  it('does not write validation.headsha when the loop fails', async () => {
    const { ctx, artifacts } = makeCtx({ withFailureJson: true });
    (ctx as { git: unknown }).git = {
      headCommitSha: async () => 'abc123def456\n',
    } as PhaseHandlerContext['git'];

    const handler = new FixValidateHandler({
      runLoop: async () => ({ phaseOutcome: 'failed' as const, loopStatus: 'failed' as const }),
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    await expect(artifacts.read(RUN_UUID, 'validation.headsha')).rejects.toThrow();
  });

  it('invalidates prior validation evidence in lean mode before repair agent runs', async () => {
    const { ctx, artifacts } = makeCtx({ withFailureJson: true });
    ctx.executionPolicy = 'standard';

    // Prior validation passed artifact exists
    await artifacts.write({
      runId: RUN_UUID,
      phaseId: 'validate',
      relativePath: 'validation.result',
      contents: 'passed\n',
    });
    await artifacts.write({
      runId: RUN_UUID,
      phaseId: 'validate',
      relativePath: 'validation.fingerprint',
      contents: 'prior-fingerprint-123\n',
    });

    const { FakeGitPort } = await import('../../../test-doubles/fake-git-port.js');
    const fakeGit = new FakeGitPort();
    fakeGit.currentBranchByCwd.set('/tmp/wt', 'ai/issue-7');
    fakeGit.headByCwd.set('/tmp/wt', '0'.repeat(40));
    (ctx as { git: unknown }).git = fakeGit;

    ctx.promptsRoot = '/tmp';
    ctx.startCommitSha = '0'.repeat(40);
    ctx.expectedBranch = 'ai/issue-7';

    const fakeAgent = {
      invoke: async () => ({
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        exitCode: 0,
        durationMs: 500,
        stdoutPath: '/tmp/stdout',
        stderrPath: '/tmp/stderr',
        resultJsonPath: 'fix-validate-result.json',
        contractViolations: [],
        outcome: 'success' as const,
      }),
    };
    (ctx as { agent: unknown }).agent = fakeAgent;
    (ctx as { resolveProfile: unknown }).resolveProfile = () => 'opencode-frontier';
    (ctx as { idFactory: unknown }).idFactory = () => 'inv-1';

    const handler = new FixValidateHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');

    // Validation evidence must be invalidated
    const valResult = await artifacts.read(RUN_UUID, 'validation.result');
    expect(valResult.trim()).toBe('invalidated');

    const fingerprint = await artifacts.read(RUN_UUID, 'validation.fingerprint');
    expect(fingerprint.trim()).toBe('');
  });
});

describe('validation_failures prompt variable composition in lean mode', () => {
  it('enriches prompt with actual log file content alongside message', async () => {
    const { ctx } = await setupLeanCtx({
      failure: {
        phase: 'validate',
        message: '1 validation command(s) failed: test (exit 1). See validate/ logs.',
        artifacts: ['validate/0-test.stderr.log'],
      },
      artifacts: [
        {
          path: 'validate/0-test.stderr.log',
          contents: 'AssertionError: expected true to be false\n    at test.ts:20:12',
        },
      ],
    });

    const handler = new FixValidateHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(mockRenderPrompt).toHaveBeenCalled();
    const promptCtx = mockRenderPrompt.mock.calls[0]?.[1];
    const validationFailures = promptCtx?.vars.validation_failures;

    expect(validationFailures).toContain('1 validation command(s) failed');
    expect(validationFailures).toContain('--- validate/0-test.stderr.log (last 100 lines) ---');
    expect(validationFailures).toContain('AssertionError: expected true to be false');
  });

  it('tails long logs to last ~100 lines', async () => {
    const lines = Array.from({ length: 150 }, (_, i) => `log line ${i + 1}`);
    const { ctx } = await setupLeanCtx({
      failure: {
        phase: 'validate',
        message: 'test failed',
        artifacts: ['validate/0-test.stderr.log'],
      },
      artifacts: [
        {
          path: 'validate/0-test.stderr.log',
          contents: lines.join('\n'),
        },
      ],
    });

    const handler = new FixValidateHandler();
    await handler.run(ctx);

    const promptCtx = mockRenderPrompt.mock.calls[0]?.[1];
    const validationFailures = promptCtx?.vars.validation_failures;

    expect(validationFailures).not.toContain('log line 1\n');
    expect(validationFailures).not.toContain('log line 50\n');
    expect(validationFailures).toContain('log line 51');
    expect(validationFailures).toContain('log line 150');
  });

  it('excludes .json artifacts from log tailing', async () => {
    const { ctx } = await setupLeanCtx({
      failure: {
        phase: 'validate',
        message: 'test failed',
        artifacts: ['validate/validation-result.json'],
      },
      artifacts: [
        {
          path: 'validate/validation-result.json',
          contents: '{"passed":false}',
        },
      ],
    });

    const handler = new FixValidateHandler();
    await handler.run(ctx);

    const promptCtx = mockRenderPrompt.mock.calls[0]?.[1];
    const validationFailures = promptCtx?.vars.validation_failures;

    expect(validationFailures).toBe('test failed');
    expect(validationFailures).not.toContain('validation-result.json');
  });

  it('handles missing/unreadable log artifact without throwing and inserts degraded note', async () => {
    const { ctx } = await setupLeanCtx({
      failure: {
        phase: 'validate',
        message: 'command failed',
        artifacts: ['validate/unwritten-log.stderr.log'],
      },
      // No log artifact written
    });

    const handler = new FixValidateHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    const promptCtx = mockRenderPrompt.mock.calls[0]?.[1];
    const validationFailures = promptCtx?.vars.validation_failures;

    expect(validationFailures).toContain('--- validate/unwritten-log.stderr.log ---');
    expect(validationFailures).toContain('(artifact unreadable)');
  });

  it('silently omits empty or whitespace-only log artifacts (Finding 3)', async () => {
    const { ctx } = await setupLeanCtx({
      failure: {
        phase: 'validate',
        message: 'test failed',
        artifacts: ['validate/0-test.stdout.log', 'validate/0-test.stderr.log'],
      },
      artifacts: [
        {
          path: 'validate/0-test.stdout.log',
          contents: '  \n\t  ',
        },
        {
          path: 'validate/0-test.stderr.log',
          contents: 'FfmpegAssemblyError: timed out after 120000ms',
        },
      ],
    });

    const handler = new FixValidateHandler();
    await handler.run(ctx);

    const promptCtx = mockRenderPrompt.mock.calls[0]?.[1];
    const validationFailures = promptCtx?.vars.validation_failures;

    expect(validationFailures).not.toContain('validate/0-test.stdout.log');
    expect(validationFailures).not.toContain('(artifact unreadable)');
    expect(validationFailures).toContain('--- validate/0-test.stderr.log (last 100 lines) ---');
    expect(validationFailures).toContain('FfmpegAssemblyError: timed out after 120000ms');
  });

  it('neutralizes runs of 3+ backticks in log content with fullwidth backticks (Finding 2)', async () => {
    const { ctx } = await setupLeanCtx({
      failure: {
        phase: 'validate',
        message: 'test failed',
        artifacts: ['validate/0-test.stderr.log'],
      },
      artifacts: [
        {
          path: 'validate/0-test.stderr.log',
          contents: 'Vitest diff:\n```\n- expected\n+ received\n```\nExtra: ````code````',
        },
      ],
    });

    const handler = new FixValidateHandler();
    await handler.run(ctx);

    const promptCtx = mockRenderPrompt.mock.calls[0]?.[1];
    const validationFailures = promptCtx?.vars.validation_failures;

    expect(validationFailures).not.toContain('```');
    expect(validationFailures).toContain('\uFF40\uFF40\uFF40');
    expect(validationFailures).toContain('\uFF40\uFF40\uFF40\uFF40');
  });

  it('falls back to raw message for malformed / non-JSON failure.json', async () => {
    const { ctx } = await setupLeanCtx({
      failureRaw: 'Deterministic validation failed with plain string.',
    });

    const handler = new FixValidateHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    const promptCtx = mockRenderPrompt.mock.calls[0]?.[1];
    expect(promptCtx?.vars.validation_failures).toBe(
      'Deterministic validation failed with plain string.',
    );
  });

  it('falls back to message when failure.json has no artifacts field', async () => {
    const { ctx } = await setupLeanCtx({
      failure: { phase: 'validate', message: 'build failed' },
    });

    const handler = new FixValidateHandler();
    await handler.run(ctx);

    const promptCtx = mockRenderPrompt.mock.calls[0]?.[1];
    expect(promptCtx?.vars.validation_failures).toBe('build failed');
  });
});

describe('ValidateHandler -> FixValidateHandler end-to-end integration', () => {
  it('integrates ValidateHandler failure into FixValidateHandler prompt using a shared FakeArtifactStore', async () => {
    const sharedArtifacts = new FakeArtifactStore();

    // 1. Run ValidateHandler that fails with known stdout/stderr
    const fakeRunValidation = {
      execute: async () => ({
        validationRun: {
          id: 'vrun-1',
          runId: RunId(RUN_UUID),
          phaseId: 'validate' as const,
          startedAt: new Date(),
          completedAt: new Date(),
          commands: [],
        },
        passed: false,
        failure: {
          runUuid: RUN_UUID,
          phase: 'validate' as const,
          kind: 'timeout' as const,
          message: '1 validation command(s) failed: test:assembly (timed out). See validate/ logs.',
          canRetry: true,
          suggestedAction: 'Open validate logs and rerun locally.',
          artifacts: [
            'validate/9-test-assembly.stdout.log',
            'validate/9-test-assembly.stderr.log',
            'validate/validation-result.json',
          ],
          detectedAt: new Date(),
        },
        results: [
          {
            command: 'pnpm test:assembly',
            exitCode: 1,
            durationMs: 120000,
            stdout: 'Worker initialized\nRunning assembly test...\n',
            stderr:
              'FfmpegAssemblyError: Process execution timed out after 120000ms: ffmpeg\n    at assembly.ts:88:14',
            stdoutPath: 'validate/9-test-assembly.stdout.log',
            stderrPath: 'validate/9-test-assembly.stderr.log',
            outcome: 'timed_out' as const,
          },
        ],
      }),
    };

    const { ctx: fixCtx, git } = await setupLeanCtx({ sharedArtifacts });

    const { ctx: validateCtx } = makeCtx();
    validateCtx.artifacts = sharedArtifacts;
    validateCtx.git = git;
    const validateHandler = new ValidateHandler({
      runValidation: fakeRunValidation as unknown as RunValidation,
      commands: ['pnpm test:assembly'],
      timeoutSeconds: 300,
      logDir: '/tmp/wt/.ai-runs/r1/validate',
      fixValidateEnabled: true,
    });

    const validateResult = await validateHandler.run(validateCtx);
    expect(validateResult.outcome).toBe('deferred');

    // Verify ValidateHandler wrote both failure.json and the log artifacts to sharedArtifacts
    expect(await sharedArtifacts.read(RUN_UUID, 'validate/failure.json')).toContain(
      '1 validation command(s) failed',
    );
    expect(await sharedArtifacts.read(RUN_UUID, 'validate/9-test-assembly.stdout.log')).toContain(
      'Worker initialized',
    );
    expect(await sharedArtifacts.read(RUN_UUID, 'validate/9-test-assembly.stderr.log')).toContain(
      'FfmpegAssemblyError: Process execution timed out after 120000ms',
    );

    // 2. Now run FixValidateHandler against the SAME sharedArtifacts
    const fixHandler = new FixValidateHandler();
    const fixResult = await fixHandler.run(fixCtx);

    expect(fixResult.outcome).toBe('passed');
    expect(mockRenderPrompt).toHaveBeenCalled();

    const promptCtx = mockRenderPrompt.mock.calls[0]?.[1];
    const validationFailures = promptCtx?.vars.validation_failures;

    // Assert that fix-validate's prompt actually contains the timeout error text and log banners!
    expect(validationFailures).toContain('1 validation command(s) failed');
    expect(validationFailures).toContain(
      '--- validate/9-test-assembly.stdout.log (last 100 lines) ---',
    );
    expect(validationFailures).toContain('Worker initialized');
    expect(validationFailures).toContain(
      '--- validate/9-test-assembly.stderr.log (last 100 lines) ---',
    );
    expect(validationFailures).toContain(
      'FfmpegAssemblyError: Process execution timed out after 120000ms: ffmpeg',
    );
  });

  describe('validation-critical files tracking', () => {
    it('records validation-critical files into validate/critical-files.json when agent modifies files to fix validation', async () => {
      const { ctx, artifacts, git } = await setupLeanCtx({
        failure: {
          phase: 'validate',
          message: 'pnpm test:whisperx timed out',
        },
      });

      git.fileContentResults.set('HEAD:packages/api/src/whisperx.ts', 'timeout=10');
      git.statusByCwd.set('/tmp/wt', '');

      const fakeAgent = (ctx as { agent: unknown }).agent as { invoke: () => Promise<unknown> };
      const origInvoke = fakeAgent.invoke;
      fakeAgent.invoke = async () => {
        git.worktreeFileContents.set('packages/api/src/whisperx.ts', 'timeout=120');
        git.statusByCwd.set('/tmp/wt', ' M packages/api/src/whisperx.ts\n');
        return origInvoke();
      };

      const handler = new FixValidateHandler();
      const result = await handler.run(ctx);

      expect(result.outcome).toBe('passed');
      const criticalRaw = await artifacts.read(RUN_UUID, 'validate/critical-files.json');
      const critical = JSON.parse(criticalRaw);
      expect(critical).toHaveLength(1);
      expect(critical[0]).toEqual(
        expect.objectContaining({
          path: 'packages/api/src/whisperx.ts',
          diagnostic: 'pnpm test:whisperx timed out',
        }),
      );
    });

    it('extracts command name from validate/validation-result.json for validation diagnostic', async () => {
      const { ctx, artifacts, git } = await setupLeanCtx({
        failure: {
          phase: 'validate',
          message: 'generic validation failure',
        },
        artifacts: [
          {
            path: 'validate/validation-result.json',
            contents: JSON.stringify({
              commands: [
                { command: 'pnpm test:unit', outcome: 'passed' },
                { command: 'pnpm test:e2e', outcome: 'failed' },
              ],
            }),
          },
        ],
      });

      git.fileContentResults.set('HEAD:packages/api/src/whisperx.ts', 'timeout=10');
      git.statusByCwd.set('/tmp/wt', '');

      const fakeAgent = (ctx as { agent: unknown }).agent as { invoke: () => Promise<unknown> };
      const origInvoke = fakeAgent.invoke;
      fakeAgent.invoke = async () => {
        git.worktreeFileContents.set('packages/api/src/whisperx.ts', 'timeout=120');
        git.statusByCwd.set('/tmp/wt', ' M packages/api/src/whisperx.ts\n');
        return origInvoke();
      };

      const handler = new FixValidateHandler();
      const result = await handler.run(ctx);

      expect(result.outcome).toBe('passed');
      const criticalRaw = await artifacts.read(RUN_UUID, 'validate/critical-files.json');
      const critical = JSON.parse(criticalRaw);
      expect(critical).toHaveLength(1);
      expect(critical[0].diagnostic).toBe('pnpm test:e2e');
    });

    it('overwrites previous validate/critical-files.json with empty array when no files are critical', async () => {
      const { ctx, artifacts, git } = await setupLeanCtx({
        failure: {
          phase: 'validate',
          message: 'flaky test passed on rerun',
        },
      });

      // Seed previous critical files
      await artifacts.write({
        runId: RUN_UUID,
        phaseId: 'fix-validate',
        relativePath: 'validate/critical-files.json',
        contents: JSON.stringify([
          {
            path: 'packages/api/src/old.ts',
            beforeHash: 'old-before',
            afterHash: 'old-after',
            diagnostic: 'old error',
          },
        ]),
      });

      git.statusByCwd.set('/tmp/wt', '');

      const handler = new FixValidateHandler();
      const result = await handler.run(ctx);

      expect(result.outcome).toBe('passed');
      const criticalRaw = await artifacts.read(RUN_UUID, 'validate/critical-files.json');
      const critical = JSON.parse(criticalRaw);
      expect(critical).toEqual([]);
    });

    it('does not invoke legacy runLoop in legacy execution policy mode', async () => {
      const { ctx } = await setupLeanCtx({
        failure: {
          kind: 'test_failure',
          phase: 'validate',
          message: 'tests failed',
          artifacts: [],
        },
      });
      ctx.executionPolicy = 'legacy';
      const runLoop = vi.fn();

      const handler = new FixValidateHandler({ runLoop });
      const result = await handler.run(ctx);

      expect(result.outcome).toBe('passed');
      expect(runLoop).not.toHaveBeenCalled();
    });
  });
});
