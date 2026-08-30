import { describe, it, expect, vi } from 'vitest';
import { FollowUpReviewHandler } from '../follow-up-review.js';
import type { PhaseHandlerContext } from '../../handler.js';
import { FakeArtifactStore, FakeAgentPort, FakeGitPort } from '../../../test-doubles/index.js';
import { PhaseName } from '@ai-sdlc/domain';
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

describe('FollowUpReviewHandler', () => {
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

  it('evaluates prior findings and marks them resolved', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('read_issue'),
      relativePath: 'issue.md',
      contents: '# Issue 1106',
    });

    const initialLedger = createFindingLedger([
      {
        severity: 'high',
        files: ['src/app.ts'],
        evidence: 'NPE',
        rationale: 'risk',
        minimal_correction: 'fix',
      },
    ]);
    const findingId = initialLedger.entries[0]!.id;

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('initial-review'),
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(initialLedger),
    });

    agent.enqueue('follow-up-review', () => ({
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
        evaluations: [
          {
            finding_id: findingId,
            resolved: true,
            evidence: 'fix verified in diff',
          },
        ],
        new_findings: [],
        summary: 'All resolved',
      }),
    });

    const handler = new FollowUpReviewHandler();

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');

    const publishedEvents = (ctx.events.publish as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const completedEvents = publishedEvents.filter(
      (call) => (call[1] as { type?: string })?.type === 'follow_up_review.completed',
    );
    expect(completedEvents).toHaveLength(1);

    const updatedLedgerRaw = await artifacts.read('run-1', 'finding-ledger.json');
    const updatedLedger = JSON.parse(updatedLedgerRaw);
    expect(updatedLedger.entries[0].status).toBe('resolved');
    expect(updatedLedger.entries[0].resolvedInIteration).toBe(1);
  });

  it('records newly detected regressions and updates finding ledger', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('read_issue'),
      relativePath: 'issue.md',
      contents: '# Issue 1106',
    });

    const initialLedger = createFindingLedger([
      {
        severity: 'high',
        files: ['src/app.ts'],
        evidence: 'NPE',
        rationale: 'risk',
        minimal_correction: 'fix',
      },
    ]);
    const findingId = initialLedger.entries[0]!.id;

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('initial-review'),
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(initialLedger),
    });

    agent.enqueue('follow-up-review', () => ({
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
        evaluations: [
          {
            finding_id: findingId,
            resolved: true,
            evidence: 'fix verified',
          },
        ],
        new_findings: [
          {
            severity: 'high',
            files: ['src/app.ts'],
            evidence: 'regression in auth flow',
            rationale: 'auth token not validated',
            minimal_correction: 'validate token',
            blocking: true,
          },
        ],
        summary: 'Prior resolved but new regression found',
      }),
    });

    const handler = new FollowUpReviewHandler();

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');

    const updatedLedgerRaw = await artifacts.read('run-1', 'finding-ledger.json');
    const updatedLedger = JSON.parse(updatedLedgerRaw);
    expect(updatedLedger.entries.length).toBe(2);
    expect(updatedLedger.entries[0].status).toBe('resolved');
    expect(updatedLedger.entries[1].status).toBe('unresolved');
    expect(updatedLedger.entries[1].rationale).toBe('auth token not validated');
    expect(updatedLedger.entries[1].sourceIteration).toBe(1);
  });

  it('overrides APPROVE verdict to REQUEST_CHANGES when unresolved blocking findings remain in ledger', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('read_issue'),
      relativePath: 'issue.md',
      contents: '# Issue 1106',
    });

    const initialLedger = createFindingLedger([
      {
        severity: 'high',
        files: ['src/app.ts'],
        evidence: 'NPE',
        rationale: 'risk',
        minimal_correction: 'fix',
      },
    ]);
    const findingId = initialLedger.entries[0]!.id;

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('initial-review'),
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(initialLedger),
    });

    agent.enqueue('follow-up-review', () => ({
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

    // Agent attempts to return APPROVE despite resolved: false
    await artifacts.write({
      runId: 'run-1',
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        evaluations: [
          {
            finding_id: findingId,
            resolved: false,
            evidence: 'not fixed yet',
          },
        ],
        new_findings: [],
        summary: 'Approving anyway',
      }),
    });

    const handler = new FollowUpReviewHandler();

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');

    // Changes requested event must be emitted
    expect(ctx.events.publish).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        type: 'follow_up_review.changes_requested',
        metadata: expect.objectContaining({
          verdict: 'REQUEST_CHANGES',
          unresolvedCount: 1,
        }),
      }),
    );

    // follow-up-review.json must persist the effective verdict (REQUEST_CHANGES), not raw APPROVE
    const followUpRaw = await artifacts.read('run-1', 'follow-up-review.json');
    const parsedFollowUp = JSON.parse(followUpRaw);
    expect(parsedFollowUp.verdict).toBe('REQUEST_CHANGES');
  });

  it('computes fix_diff against prior reviewed commit SHA when review-head-sha.txt is present', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('read_issue'),
      relativePath: 'issue.md',
      contents: '# Issue 1106',
    });

    const initialLedger = createFindingLedger([
      {
        severity: 'high',
        files: ['src/app.ts'],
        evidence: 'NPE',
        rationale: 'risk',
        minimal_correction: 'fix',
      },
    ]);
    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('initial-review'),
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(initialLedger),
    });

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('initial-review'),
      relativePath: 'review-head-sha.txt',
      contents: '1111111111111111111111111111111111111111',
    });

    const diffSpy = vi.spyOn(git, 'diff');

    agent.enqueue('follow-up-review', () => ({
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
        evaluations: [
          {
            finding_id: initialLedger.entries[0]!.id,
            resolved: true,
            evidence: 'fixed',
          },
        ],
        new_findings: [],
        summary: 'All fixed',
      }),
    });

    const handler = new FollowUpReviewHandler();

    await handler.run(ctx);

    // Verify git.diff was called with the prior review HEAD SHA
    expect(diffSpy).toHaveBeenCalledWith('/test/repo', '1111111111111111111111111111111111111111');
  });

  it('blocks follow-up review and does not invoke agent when validation.result is missing', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('read_issue'),
      relativePath: 'issue.md',
      contents: '# Issue 1106',
    });

    const handler = new FollowUpReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('validation_failed');
      expect(result.failure.message).toContain('deterministic validation has not passed');
    }
    expect(agent.invocations).toHaveLength(0);
  });

  it('blocks follow-up review and does not invoke agent when validation evidence is stale after source mutation', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort();
    const git = new FakeGitPort();
    const ctx = createMockContext(artifacts, agent, git);

    await recordValidationEvidence(ctx, 'validate');

    // Subsequent uncommitted source mutation occurs
    git.statusByCwd.set('/test/repo', ' M src/new-fix.ts\n');

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('read_issue'),
      relativePath: 'issue.md',
      contents: '# Issue 1106',
    });

    const handler = new FollowUpReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('validation_failed');
      expect(result.failure.message).toContain('Validation evidence is stale');
    }
    expect(agent.invocations).toHaveLength(0);
  });
});
