import { describe, it, expect, vi } from 'vitest';
import { AgentProfileName } from '@ai-sdlc/domain';
import { QualityReviewHandler } from '../quality-review.js';
import { FakeArtifactStore, FakeGitPort, FakeAgentPort } from '../../../test-doubles/index.js';
import type { PhaseHandlerContext } from '../../handler.js';
import { recordValidationEvidence } from '../../validation-evidence.js';
import { createFindingLedger } from '../../../review-fix/finding-ledger.js';

const { mockLoadPromptTemplate, mockRenderPrompt } = vi.hoisted(() => ({
  mockLoadPromptTemplate: vi.fn(() => '# Quality Review Template\n'),
  mockRenderPrompt: vi.fn(async () => '# Rendered Prompt\n'),
}));

vi.mock('../../../prompts/load-prompt-template.js', () => ({
  loadPromptTemplate: mockLoadPromptTemplate,
}));

vi.mock('../../../prompts/render-prompt.js', () => ({
  renderPrompt: mockRenderPrompt,
}));

describe('QualityReviewHandler', () => {
  const setup = () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    const agent = new FakeAgentPort();
    const events = { publish: vi.fn() };

    git.headByCwd.set('/tmp/worktree', 'commit-sha-1132');
    git.currentBranchByCwd.set('/tmp/worktree', 'ai/issue-1132');

    const ctx: PhaseHandlerContext = {
      runId: 'run-1132',
      runUuid: 'run-1132',
      issueNumber: 1132,
      repoFullName: 'owner/repo',
      cwd: '/tmp/worktree',
      executionPolicy: 'standard',
      promptsRoot: '/tmp',
      startCommitSha: 'commit-sha-1132',
      expectedBranch: 'ai/issue-1132',
      artifacts,
      git,
      agent,
      events,
      now: () => new Date('2026-08-31T00:00:00Z'),
      idFactory: () => 'inv-1',
      resolveProfile: (phase: string) =>
        phase === 'post-implementation-quality-review' || phase === 'quality-review'
          ? AgentProfileName('quality-review')
          : AgentProfileName(phase),
    };

    const handler = new QualityReviewHandler();

    return { ctx, artifacts, git, agent, events, handler };
  };

  it('fails with missing_artifact when issue.md is missing', async () => {
    const { ctx, handler } = setup();

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('missing_artifact');
    }
  });

  it('fails with validation_failed when deterministic validation is stale or missing', async () => {
    const { ctx, artifacts, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132',
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('validation_failed');
    }
  });

  it('executes quality review and approves when no defects are identified', async () => {
    const { ctx, artifacts, agent, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'spec-review.md',
      contents: '# Spec Review\nAll good',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'spec-review.json',
      contents: JSON.stringify({ verdict: 'PASS', summary: 'All ACs pass' }),
    });

    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('quality-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          findings: [],
          summary: 'Architecture and error handling are sound',
        }),
      });
      return {
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
      };
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');

    const qualJson = await artifacts.read(ctx.runUuid, 'quality-review.json');
    expect(JSON.parse(qualJson).verdict).toBe('APPROVE');

    const qualMd = await artifacts.read(ctx.runUuid, 'quality-review.md');
    expect(qualMd).toContain('# Quality Review');

    const codeReviewMd = await artifacts.read(ctx.runUuid, 'code-review.md');
    expect(codeReviewMd).toContain('# Spec Review');
    expect(codeReviewMd).toContain('# Quality Review');

    const headSha = await artifacts.read(ctx.runUuid, 'review-head-sha.txt');
    expect(headSha.trim()).toBe('commit-sha-1132');
  });

  it('appends quality review findings to existing spec finding ledger', async () => {
    const { ctx, artifacts, agent, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132',
    });

    // Seed spec review findings
    const initialLedger = createFindingLedger(
      [
        {
          severity: 'high',
          files: ['src/spec.ts'],
          evidence: 'Missing spec feature',
          rationale: 'Spec gap',
          minimal_correction: 'Add feature',
        },
      ],
      [],
      'spec-review',
    );
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'finding-ledger.json',
      contents: JSON.stringify(initialLedger),
    });

    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('quality-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'REQUEST_CHANGES',
          findings: [
            {
              category: 'architecture',
              severity: 'critical',
              files: ['packages/application/src/bad.ts'],
              evidence: 'Imports infrastructure directly',
              rationale: 'Breaks AGENTS.md layer boundary',
              minimal_correction: 'Use port',
              blocking: true,
            },
          ],
          summary: 'Layer boundary defect identified',
        }),
      });
      return {
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
      };
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');

    const qualJson = await artifacts.read(ctx.runUuid, 'quality-review.json');
    expect(JSON.parse(qualJson).verdict).toBe('REQUEST_CHANGES');

    const ledgerRaw = await artifacts.read(ctx.runUuid, 'finding-ledger.json');
    const ledger = JSON.parse(ledgerRaw);
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries[0].source).toBe('spec-review');
    expect(ledger.entries[1].source).toBe('quality-review');
    expect(ledger.entries[1].severity).toBe('critical');
  });

  it('resumes with approval reuse when recorded review-head-sha matches current HEAD', async () => {
    const { ctx, artifacts, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'quality-review.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        findings: [],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'review-head-sha.txt',
      contents: 'commit-sha-1132\n',
    });
    await recordValidationEvidence(ctx, 'validate');

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');
  });

  it('does NOT reuse review approval if deterministic validation is missing or stale on resume', async () => {
    const { ctx, artifacts, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'quality-review.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        findings: [],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'review-head-sha.txt',
      contents: 'commit-sha-1132\n',
    });

    // Validation evidence is missing
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132',
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('validation_failed');
    }
  });

  it('does NOT reuse review approval when worktree HEAD has advanced (stale approval)', async () => {
    const { ctx, artifacts, agent, handler, git } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'quality-review.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        findings: [],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'review-head-sha.txt',
      contents: 'old-stale-sha\n',
    });

    git.headByCwd.set('/tmp/worktree', 'new-head-sha');
    ctx.startCommitSha = 'new-head-sha';
    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('quality-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'APPROVE',
          findings: [],
          summary: 'Clean on new commit',
        }),
      });
      return {
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
      };
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');

    const headSha = await artifacts.read(ctx.runUuid, 'review-head-sha.txt');
    expect(headSha.trim()).toBe('new-head-sha');
  });
});
