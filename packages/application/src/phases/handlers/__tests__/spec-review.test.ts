import { describe, it, expect, vi } from 'vitest';
import { AgentProfileName } from '@ai-sdlc/domain';
import { SpecReviewHandler } from '../spec-review.js';
import { FakeArtifactStore, FakeGitPort, FakeAgentPort } from '../../../test-doubles/index.js';
import type { PhaseHandlerContext } from '../../handler.js';
import { recordValidationEvidence } from '../../validation-evidence.js';

const { mockLoadPromptTemplate, mockRenderPrompt } = vi.hoisted(() => ({
  mockLoadPromptTemplate: vi.fn(() => '# Spec Review Template\n'),
  mockRenderPrompt: vi.fn(async () => '# Rendered Prompt\n'),
}));

vi.mock('../../../prompts/load-prompt-template.js', () => ({
  loadPromptTemplate: mockLoadPromptTemplate,
}));

vi.mock('../../../prompts/render-prompt.js', () => ({
  renderPrompt: mockRenderPrompt,
}));

describe('SpecReviewHandler', () => {
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
        phase === 'post-implementation-spec-review' || phase === 'spec-review'
          ? AgentProfileName('spec-review')
          : AgentProfileName(phase),
    };

    const handler = new SpecReviewHandler();

    return { ctx, artifacts, git, agent, events, handler };
  };

  it('fails with missing_artifact when issue.md or design.md is missing', async () => {
    const { ctx, handler } = setup();

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('missing_artifact');
    }
  });

  it('fails with validation_failed when deterministic validation evidence is missing or stale', async () => {
    const { ctx, artifacts, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132\n## Acceptance Criteria\n- [ ] Must preflight capabilities',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1132',
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('validation_failed');
    }
  });

  it('executes spec review and approves when all requirements pass', async () => {
    const { ctx, artifacts, agent, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132\n## Acceptance Criteria\n- [ ] Must preflight capabilities',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1132',
    });

    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('spec-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'PASS',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Must preflight capabilities',
              result: 'PASS',
              evidence: 'Checked preflight capability checks in ffmpeg service',
              test_evidence: 'Preflight unit test passes',
              counterexample_considered: 'Tested missing filter capability error path',
            },
          ],
          findings: [],
          summary: 'All requirements satisfied',
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

    // Artifacts persisted
    const specJson = await artifacts.read(ctx.runUuid, 'spec-review.json');
    expect(JSON.parse(specJson).verdict).toBe('PASS');

    const specMd = await artifacts.read(ctx.runUuid, 'spec-review.md');
    expect(specMd).toContain('# Spec Review');
    expect(specMd).toContain('Must preflight capabilities');

    const codeReviewMd = await artifacts.read(ctx.runUuid, 'code-review.md');
    expect(codeReviewMd).toContain('# Spec Review');

    const ledgerRaw = await artifacts.read(ctx.runUuid, 'finding-ledger.json');
    const ledger = JSON.parse(ledgerRaw);
    expect(ledger.entries).toHaveLength(0);

    const headSha = await artifacts.read(ctx.runUuid, 'review-head-sha.txt');
    expect(headSha.trim()).toBe('commit-sha-1132');

    // The reviewer is given the orchestrator's own bookkeeping filenames so
    // it doesn't independently discover them via `git status` and flag them
    // as scratch-artifact/hygiene findings.
    const renderCall = mockRenderPrompt.mock.calls.at(-1)?.[1] as { vars: Record<string, string> };
    expect(renderCall.vars.orchestrator_bookkeeping_files).toContain('review-head-sha.txt');
    expect(renderCall.vars.orchestrator_bookkeeping_files).toContain('spec-review-head-sha.txt');
  });

  it('records failing requirements in finding-ledger when spec review requests changes', async () => {
    const { ctx, artifacts, agent, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132\n## Acceptance Criteria\n- [ ] Must preflight capabilities',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1132',
    });

    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('spec-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'FAIL',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Must preflight capabilities',
              result: 'FAIL',
              evidence: 'Capabilities not preflighted before dispatch',
              test_evidence: 'Missing test',
              counterexample_considered: 'Missing capability crashes FFmpeg downstream',
            },
          ],
          findings: [
            {
              severity: 'high',
              files: ['src/ffmpeg.ts'],
              evidence: 'No preflight call',
              rationale: 'FFmpeg fails downstream on missing filter',
              minimal_correction: 'Add preflight check',
              blocking: true,
            },
          ],
          summary: 'Preflight requirement failed',
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

    const specJson = await artifacts.read(ctx.runUuid, 'spec-review.json');
    expect(JSON.parse(specJson).verdict).toBe('FAIL');

    const ledgerRaw = await artifacts.read(ctx.runUuid, 'finding-ledger.json');
    const ledger = JSON.parse(ledgerRaw);
    expect(ledger.entries.length).toBeGreaterThanOrEqual(1);
    expect(ledger.entries[0].source).toBe('spec-review');
  });

  it('resumes with approval reuse when recorded review-head-sha matches current HEAD', async () => {
    const { ctx, artifacts, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'spec-review.json',
      contents: JSON.stringify({
        verdict: 'PASS',
        requirements_checks: [
          {
            requirement_id: 'AC-1',
            requirement: 'Must preflight capabilities',
            result: 'PASS',
            evidence: 'Checked',
            counterexample_considered: 'Tested missing',
          },
        ],
        findings: [],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'spec-requirements-ledger.json',
      contents: JSON.stringify({
        version: 1,
        issueNumber: 1132,
        items: [
          {
            id: 'AC-1',
            category: 'acceptance_criteria',
            title: 'Must preflight capabilities',
            source: 'issue.md',
            hardGate: true,
          },
        ],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'review-head-sha.txt',
      contents: 'commit-sha-1132\n',
    });
    await recordValidationEvidence(ctx, 'validate');

    // Agent should NOT be invoked
    const res = await handler.run(ctx);
    expect(res.outcome).toBe('passed');
  });

  it('does NOT reuse review approval if deterministic validation is missing or stale on resume', async () => {
    const { ctx, artifacts, handler } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'spec-review.json',
      contents: JSON.stringify({
        verdict: 'PASS',
        requirements_checks: [
          {
            requirement_id: 'AC-1',
            requirement: 'Must preflight capabilities',
            result: 'PASS',
            evidence: 'Checked',
            counterexample_considered: 'Tested missing',
          },
        ],
        findings: [],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'spec-requirements-ledger.json',
      contents: JSON.stringify({
        version: 1,
        issueNumber: 1132,
        items: [
          {
            id: 'AC-1',
            category: 'acceptance_criteria',
            title: 'Must preflight capabilities',
            source: 'issue.md',
            hardGate: true,
          },
        ],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'review-head-sha.txt',
      contents: 'commit-sha-1132\n',
    });

    // Validation evidence is NOT recorded / invalid
    // Execution falls through to required inputs check and fails validation_failed
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1132',
    });

    const res = await handler.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('validation_failed');
    }
  });

  it('does NOT reuse review approval if worktree HEAD has changed since approval (stale approval)', async () => {
    const { ctx, artifacts, agent, handler, git } = setup();

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'issue.md',
      contents: '# Issue 1132\n## Acceptance Criteria\n- [ ] Must preflight capabilities',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design 1132',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'spec-review.json',
      contents: JSON.stringify({
        verdict: 'PASS',
        requirements_checks: [
          {
            requirement_id: 'AC-1',
            requirement: 'Must preflight capabilities',
            result: 'PASS',
            evidence: 'Checked',
            counterexample_considered: 'Tested missing',
          },
        ],
        findings: [],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'review-head-sha.txt',
      contents: 'old-stale-sha\n',
    });

    // Current HEAD is different
    git.headByCwd.set('/tmp/worktree', 'new-commit-sha');
    ctx.startCommitSha = 'new-commit-sha';
    await recordValidationEvidence(ctx, 'validate');

    agent.enqueue('spec-review', async () => {
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'result.json',
        contents: JSON.stringify({
          verdict: 'PASS',
          requirements_checks: [
            {
              requirement_id: 'AC-1',
              requirement: 'Must preflight capabilities',
              result: 'PASS',
              evidence: 'Re-verified against new HEAD',
              counterexample_considered: 'Tested adversarial on new commit',
            },
          ],
          findings: [],
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
    // Fresh SHA should now be persisted
    const headSha = await artifacts.read(ctx.runUuid, 'review-head-sha.txt');
    expect(headSha.trim()).toBe('new-commit-sha');
  });
});
