import { describe, it, expect, vi } from 'vitest';
import { InitialReviewHandler } from '../initial-review.js';
import type { PhaseHandlerContext } from '../../handler.js';
import { FakeArtifactStore, FakeAgentPort, FakeGitPort } from '../../../test-doubles/index.js';
import { PhaseName } from '@ai-sdlc/domain';
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

describe('InitialReviewHandler', () => {
  const createMockContext = (
    artifacts: FakeArtifactStore,
    agent: FakeAgentPort,
    git: FakeGitPort,
  ): PhaseHandlerContext => {
    git.currentBranchByCwd.set('/test/repo', 'ai/issue-1106');
    git.headByCwd.set('/test/repo', '0'.repeat(40));
    return {
      runUuid: 'run-1',
      issueNumber: 1106,
      repoFullName: 'owner/repo',
      cwd: '/test/repo',
      executionPolicy: 'standard',
      promptsRoot: '/tmp',
      startCommitSha: '0'.repeat(40),
      expectedBranch: 'ai/issue-1106',
      artifacts,
      agent,
      git,
      events: { publish: vi.fn() },
      now: () => new Date(),
      idFactory: () => 'inv-1',
      resolveProfile: (phase) => phase as never,
    } as unknown as PhaseHandlerContext;
  };

  it('runs whole-change review and produces APPROVE verdict when validation is fresh', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('read_issue'),
      relativePath: 'issue.md',
      contents: '# Issue 1106\nGoal: Build feature',
    });

    agent.enqueue('initial-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        acceptance_criteria: [{ criterion: 'AC 1', result: 'PASS', evidence: 'Tested' }],
        findings: [],
        summary: 'Looks good',
      }),
    });

    const handler = new InitialReviewHandler();

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');

    const publishedEvents = (ctx.events.publish as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const completedEvents = publishedEvents.filter(
      (call) => (call[1] as { type?: string })?.type === 'initial_review.completed',
    );
    expect(completedEvents).toHaveLength(1);

    const reviewJson = await artifacts.read('run-1', 'whole-change-review.json');
    expect(JSON.parse(reviewJson).verdict).toBe('APPROVE');

    const codeReviewMd = await artifacts.read('run-1', 'code-review.md');
    expect(codeReviewMd).toContain('**Verdict:** APPROVE');
  });

  it('records findings in finding-ledger.json on REQUEST_CHANGES', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('read_issue'),
      relativePath: 'issue.md',
      contents: '# Issue 1106\nGoal: Build feature',
    });

    agent.enqueue('initial-review', () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      exitCode: 0,
      durationMs: 1000,
      stdoutPath: '/tmp/stdout',
      stderrPath: '/tmp/stderr',
      resultJsonPath: 'result.json',
      contractViolations: [],
      outcome: 'success',
    }));

    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        acceptance_criteria: [
          { criterion: 'AC 1', result: 'FAIL', evidence: 'Missing validation' },
        ],
        findings: [
          {
            severity: 'high',
            files: ['src/app.ts'],
            evidence: 'Missing check',
            rationale: 'NPE risk',
            minimal_correction: 'Add check',
            blocking: true,
          },
        ],
        summary: 'Changes requested',
      }),
    });

    const handler = new InitialReviewHandler();

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');

    const ledgerRaw = await artifacts.read('run-1', 'finding-ledger.json');
    const ledger = JSON.parse(ledgerRaw);
    expect(ledger.entries.length).toBe(2); // AC-1 failure + 1 finding
    expect(ledger.entries[0].status).toBe('unresolved');
    expect(ledger.entries[1].status).toBe('unresolved');
  });

  it('blocks initial review and does not invoke agent when validation.result is missing', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('read_issue'),
      relativePath: 'issue.md',
      contents: '# Issue 1106\nGoal: Build feature',
    });

    const handler = new InitialReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('validation_failed');
      expect(result.failure.message).toContain('deterministic validation has not passed');
    }
    expect(agent.invocations).toHaveLength(0);
  });

  it('blocks initial review and does not invoke agent when validation evidence is stale after source mutation', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    // Initial validation ran on clean state
    await recordValidationEvidence(ctx, 'validate');

    // Subsequent uncommitted source mutation occurs
    git.statusByCwd.set('/test/repo', ' M src/app.ts\n');

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('read_issue'),
      relativePath: 'issue.md',
      contents: '# Issue 1106\nGoal: Build feature',
    });

    const handler = new InitialReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('validation_failed');
      expect(result.failure.message).toContain('Validation evidence is stale');
    }
    expect(agent.invocations).toHaveLength(0);
  });
});
