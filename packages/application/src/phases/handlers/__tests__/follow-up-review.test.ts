import { describe, it, expect, vi } from 'vitest';
import { FollowUpReviewHandler } from '../follow-up-review.js';
import type { PhaseHandlerContext } from '../../handler.js';
import { FakeArtifactStore, FakeAgentPort, FakeGitPort } from '../../../test-doubles/index.js';
import { PhaseName } from '@ai-sdlc/domain';
import { createFindingLedger } from '../../../review-fix/finding-ledger.js';

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
    const ctx = createMockContext(artifacts, agent, git);

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');

    const updatedLedgerRaw = await artifacts.read('run-1', 'finding-ledger.json');
    const updatedLedger = JSON.parse(updatedLedgerRaw);
    expect(updatedLedger.entries[0].status).toBe('resolved');
    expect(updatedLedger.entries[0].resolvedInIteration).toBe(1);
  });
});
