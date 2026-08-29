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

    agent.enqueue('fix-review', () => ({
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

    const handler = new FixReviewHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');

    // Validation evidence must be invalidated
    const valResultAfter = await artifacts.read('run-1', 'validation.result');
    expect(valResultAfter.trim()).toBe('invalidated');
  });
});
