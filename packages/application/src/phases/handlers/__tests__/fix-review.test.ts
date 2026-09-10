import { describe, it, expect, vi } from 'vitest';
import { FixReviewHandler } from '../fix-review.js';
import type { PhaseHandlerContext } from '../../handler.js';
import { FakeArtifactStore, FakeAgentPort, FakeGitPort } from '../../../test-doubles/index.js';
import { createFindingLedger } from '../../../review-fix/finding-ledger.js';
import { recordValidationEvidence } from '../../validation-evidence.js';

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

describe('FixReviewHandler', () => {
  const createMockContext = (
    artifacts: FakeArtifactStore,
    agent: FakeAgentPort,
    git: FakeGitPort,
  ): PhaseHandlerContext => {
    git.currentBranchByCwd.set('/test/repo', 'ai/issue-1109');
    git.headByCwd.set('/test/repo', '0'.repeat(40));
    return {
      runUuid: 'run-1',
      issueNumber: 1109,
      repoFullName: 'owner/repo',
      cwd: '/test/repo',
      executionPolicy: 'standard',
      promptsRoot: '/tmp',
      startCommitSha: '0'.repeat(40),
      expectedBranch: 'ai/issue-1109',
      artifacts,
      agent,
      git,
      events: { publish: vi.fn() },
      now: () => new Date(),
      idFactory: () => 'inv-1',
      resolveProfile: (phase) => phase as never,
    } as unknown as PhaseHandlerContext;
  };

  it('executes targeted review-fix and invalidates prior validation evidence', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    // Initial validation was passed
    await recordValidationEvidence(ctx, 'validate');
    const valResultBefore = await artifacts.read('run-1', 'validation.result');
    expect(valResultBefore.trim()).toBe('passed');

    const ledger = createFindingLedger([
      {
        severity: 'high',
        files: ['src/index.ts'],
        evidence: 'Error handling bug',
        rationale: 'Crash risk',
        minimal_correction: 'Add try catch',
      },
    ]);
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(ledger),
    });

    await artifacts.write({
      runId: 'run-1',
      relativePath: 'fix-review-result.json',
      contents: JSON.stringify({ result: 'done_with_fixes' }),
    });

    agent.enqueue('fix-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'fix-review-result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const handler = new FixReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');

    const publishedEvents = (ctx.events.publish as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const completedEvents = publishedEvents.filter(
      (call) => (call[1] as { type?: string })?.type === 'fix_review.completed',
    );
    expect(completedEvents).toHaveLength(1);

    // Validation evidence must be invalidated
    const valResultAfter = await artifacts.read('run-1', 'validation.result');
    expect(valResultAfter.trim()).toBe('invalidated');
  });

  it('returns needs_human_review when fixer reports cannot_fix', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');

    const ledger = createFindingLedger([
      {
        severity: 'high',
        files: ['src/index.ts'],
        evidence: 'Fatal bug',
        rationale: 'Crash risk',
        minimal_correction: 'Refactor',
      },
    ]);
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(ledger),
    });

    await artifacts.write({
      runId: 'run-1',
      relativePath: 'fix-review-result.json',
      contents: JSON.stringify({ result: 'cannot_fix' }),
    });

    agent.enqueue('fix-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'fix-review-result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const handler = new FixReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    const publishedEvents = (ctx.events.publish as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const completedEvents = publishedEvents.filter(
      (call) => (call[1] as { type?: string })?.type === 'fix_review.completed',
    );
    expect(completedEvents).toHaveLength(0);
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.kind).toBe('needs_human_review');
      expect(result.failure.message).toContain('targeted fixer reported it cannot fix');
    }
  });

  it('tolerates control characters in fix-review-result.json via centralized ingestion', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');

    const ledger = createFindingLedger([
      {
        severity: 'high',
        files: ['src/index.ts'],
        evidence: 'Fatal bug',
        rationale: 'Crash risk',
        minimal_correction: 'Refactor',
      },
    ]);
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(ledger),
    });

    // Contains raw newline inside rebuttal string literal (defect from #1127)
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'fix-review-result.json',
      contents: '{\n  "result": "done_no_fixes_needed",\n  "rebuttal": "Fixed already.\nLine 2"\n}',
    });

    agent.enqueue('fix-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'fix-review-result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const handler = new FixReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
  });

  it('injects validation_critical_files warning into targeted-fix prompt vars', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(createFindingLedger([])),
    });
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'fix-review-result.json',
      contents: JSON.stringify({ result: 'done_with_fixes' }),
    });

    await artifacts.write({
      runId: 'run-1',
      relativePath: 'validate/critical-files.json',
      contents: JSON.stringify([
        {
          path: 'packages/api/src/whisperx.ts',
          beforeHash: 'hash-before',
          afterHash: 'hash-after',
          diagnostic: 'pnpm test:whisperx timed out',
        },
      ]),
    });

    // File remains in afterHash state
    git.worktreeFileContents.set('packages/api/src/whisperx.ts', 'after content');

    agent.enqueue('fix-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'fix-review-result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const handler = new FixReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(mockRenderPrompt).toHaveBeenCalled();
    const lastCall = mockRenderPrompt.mock.calls[mockRenderPrompt.mock.calls.length - 1];
    const promptCtx = lastCall?.[1];
    expect(promptCtx?.vars.validation_critical_files).toContain('packages/api/src/whisperx.ts');
    expect(promptCtx?.vars.validation_critical_files).toContain('pnpm test:whisperx timed out');
  });

  it('injects SELF_VERIFY_INSTRUCTIONS into targeted-fix prompt vars based on selfVerifyCommands', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(createFindingLedger([])),
    });
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'fix-review-result.json',
      contents: JSON.stringify({ result: 'done_with_fixes' }),
    });

    agent.enqueue('fix-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'fix-review-result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const handler = new FixReviewHandler({
      selfVerifyCommands: ['pnpm typecheck', 'pnpm lint'],
    });
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    const lastCall = mockRenderPrompt.mock.calls[mockRenderPrompt.mock.calls.length - 1];
    const promptCtx = lastCall?.[1];
    expect(promptCtx?.vars.SELF_VERIFY_INSTRUCTIONS).toContain('Limit your own verification to:');
    expect(promptCtx?.vars.SELF_VERIFY_INSTRUCTIONS).toContain('- `pnpm typecheck`');
    expect(promptCtx?.vars.SELF_VERIFY_INSTRUCTIONS).toContain('- `pnpm lint`');
    expect(promptCtx?.vars.SELF_VERIFY_INSTRUCTIONS).toContain(
      'plus only the specific unit test(s) that directly cover your changes.',
    );
  });

  it('falls back to default generic SELF_VERIFY_INSTRUCTIONS when selfVerifyCommands is not configured', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(createFindingLedger([])),
    });
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'fix-review-result.json',
      contents: JSON.stringify({ result: 'done_with_fixes' }),
    });

    agent.enqueue('fix-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'fix-review-result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const handler = new FixReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    const lastCall = mockRenderPrompt.mock.calls[mockRenderPrompt.mock.calls.length - 1];
    const promptCtx = lastCall?.[1];
    expect(promptCtx?.vars.SELF_VERIFY_INSTRUCTIONS).toBe(
      'Limit your own verification to: typecheck and lint for the files you changed, plus only the specific unit test(s) that directly cover them.',
    );
  });

  it('halts with needs_human_review when fixer reverts a validation-critical file to pre-fix state', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(createFindingLedger([])),
    });
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'fix-review-result.json',
      contents: JSON.stringify({ result: 'done_with_fixes' }),
    });

    // hashContent of 'timeout=10'
    const crypto = await import('node:crypto');
    const beforeContent = 'timeout=10';
    const beforeHash = crypto.createHash('sha256').update(beforeContent).digest('hex');

    await artifacts.write({
      runId: 'run-1',
      relativePath: 'validate/critical-files.json',
      contents: JSON.stringify([
        {
          path: 'packages/api/src/whisperx.ts',
          beforeHash,
          afterHash: 'sha256-after',
          diagnostic: 'pnpm test:whisperx timed out',
        },
      ]),
    });

    // Worktree content matches beforeContent (reverted!)
    git.worktreeFileContents.set('packages/api/src/whisperx.ts', beforeContent);

    agent.enqueue('fix-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'fix-review-result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const handler = new FixReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.message).toContain(
        'Validation-critical file "packages/api/src/whisperx.ts" was reverted',
      );
    }

    const publishedEvents = (ctx.events.publish as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const revertEvents = publishedEvents.filter(
      (call) =>
        (call[1] as { type?: string })?.type === 'review_fix.validation_critical_file_reverted',
    );
    expect(revertEvents).toHaveLength(1);
    expect((revertEvents[0][1] as { metadata?: { path?: string } }).metadata?.path).toBe(
      'packages/api/src/whisperx.ts',
    );
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.artifacts).toEqual([
        'code-review.md',
        'finding-ledger.json',
        'validate/critical-files.json',
      ]);
    }
  });

  it('emits review_fix.validation_critical_file_read_failed on non-ENOENT read error when file was deleted before', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(createFindingLedger([])),
    });
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'fix-review-result.json',
      contents: JSON.stringify({ result: 'done_with_fixes' }),
    });

    await artifacts.write({
      runId: 'run-1',
      relativePath: 'validate/critical-files.json',
      contents: JSON.stringify([
        {
          path: 'packages/api/src/deleted.ts',
          beforeHash: '__DELETED__',
          afterHash: 'sha256-after',
          diagnostic: 'pnpm test failed',
        },
      ]),
    });

    // File content cannot be read, but git status reports it is present (modified, not deleted)
    git.defaultWorktreeFileContent = () => undefined;
    git.statusByCwd.set('/test/repo', ' M packages/api/src/deleted.ts');

    agent.enqueue('fix-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'fix-review-result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    const handler = new FixReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    const publishedEvents = (ctx.events.publish as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const readFailedEvents = publishedEvents.filter(
      (call) =>
        (call[1] as { type?: string })?.type === 'review_fix.validation_critical_file_read_failed',
    );
    expect(readFailedEvents).toHaveLength(1);
    expect((readFailedEvents[0][1] as { metadata?: { path?: string } }).metadata?.path).toBe(
      'packages/api/src/deleted.ts',
    );
  });
});
