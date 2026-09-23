import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PhaseName } from '@ai-sdlc/domain';
import { runSingleShotAgentPhase } from '../run-single-shot-agent-phase.js';
import type { PhaseHandlerContext } from '../../handler.js';
import { FakeArtifactStore, FakeAgentPort, FakeGitPort } from '../../../test-doubles/index.js';

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

describe('runSingleShotAgentPhase - Candidate Validation Governance Boundary', () => {
  let artifacts: FakeArtifactStore;
  let agent: FakeAgentPort;
  let git: FakeGitPort;
  let ctx: PhaseHandlerContext;
  let publishedEvents: Array<{ type: string; level: string; message: string; metadata?: unknown }>;

  beforeEach(() => {
    artifacts = new FakeArtifactStore();
    agent = new FakeAgentPort();
    git = new FakeGitPort();
    publishedEvents = [];

    git.currentBranchByCwd.set('/test/repo', 'ai/issue-1273');
    git.headByCwd.set('/test/repo', '0'.repeat(40));

    ctx = {
      runUuid: 'run-1273',
      issueNumber: 1273,
      repoFullName: 'owner/repo',
      cwd: '/test/repo',
      executionPolicy: 'standard',
      promptsRoot: '/tmp/prompts',
      startCommitSha: '0'.repeat(40),
      expectedBranch: 'ai/issue-1273',
      artifacts,
      agent,
      git,
      events: {
        publish: vi.fn((_runId, event) => {
          publishedEvents.push(event);
        }),
      },
      now: () => new Date(),
      idFactory: () => 'inv-1273',
      resolveProfile: (phase) => phase as never,
    } as unknown as PhaseHandlerContext;
  });

  it('halts with needs_human_review when agent creates fabricated candidate validation report', async () => {
    // Agent invocation creates docs/phase-3-candidate-validation-report.md
    agent.enqueue('full', async () => {
      const reportPath = 'docs/phase-3-candidate-validation-report.md';
      git.worktreeFilesByCwd.set('/test/repo', [reportPath]);
      git.worktreeFileContents.set(
        `/test/repo:${reportPath}`,
        '# Phase 3 Candidate Validation Report\n\nReviewing Authority (Sign-off): opsclawd (operator)\n- [x] GO\n',
      );
      return {
        outcome: 'success',
        exitCode: 0,
        durationMs: 100,
      };
    });

    const result = await runSingleShotAgentPhase(ctx, {
      phase: PhaseName('implement'),
      profile: 'full' as never,
      step: 'implement',
      vars: {},
      agentContract: {},
      skipResultExtraction: true,
    });

    expect(result.outcome).toBe('needs_human_review');
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.kind).toBe('needs_human_review');
      expect(result.failure.canRetry).toBe(false);
      expect(result.failure.message).toContain('Candidate-validation governance violation');
    }

    const govViolationEvent = publishedEvents.find(
      (e) => e.type === 'implement.governance_violation',
    );
    expect(govViolationEvent).toBeDefined();

    const needsReviewEvent = publishedEvents.find((e) => e.type === 'implement.needs_human_review');
    expect(needsReviewEvent).toBeDefined();
  });

  it('halts non-retryably when agent deletes pre-existing candidate validation report (Witness-3)', async () => {
    const existingReport = 'docs/phase-1-candidate-validation-report.md';
    git.worktreeFilesByCwd.set('/test/repo', [existingReport]);
    git.worktreeFileContents.set(
      `/test/repo:${existingReport}`,
      '# Phase 1 Report\n- [x] GO\nSigned-by: operator\n',
    );

    // Agent deletes the pre-existing report
    agent.enqueue('full', async () => {
      git.worktreeFilesByCwd.set('/test/repo', []);
      git.worktreeFileContents.delete(`/test/repo:${existingReport}`);
      return {
        outcome: 'success',
        exitCode: 0,
        durationMs: 100,
      };
    });

    const result = await runSingleShotAgentPhase(ctx, {
      phase: PhaseName('implement'),
      profile: 'full' as never,
      step: 'implement',
      vars: {},
      agentContract: {},
      skipResultExtraction: true,
    });

    expect(result.outcome).toBe('needs_human_review');
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.kind).toBe('needs_human_review');
      expect(result.failure.canRetry).toBe(false);
      expect(result.failure.message).toContain('DELETED_RECOGNIZED_ARTIFACT');
    }
  });

  it('allows agent to create clean blank template without findings', async () => {
    agent.enqueue('full', async () => {
      const templatePath = 'docs/phase-3-report-template.md';
      git.worktreeFilesByCwd.set('/test/repo', [templatePath]);
      git.worktreeFileContents.set(
        `/test/repo:${templatePath}`,
        '# Phase 3 Report Template\n- [ ] GO\n- [ ] NO-GO\nCandidate SHA: <pinned-candidate-sha>\n',
      );
      return {
        outcome: 'success',
        exitCode: 0,
        durationMs: 100,
      };
    });

    const result = await runSingleShotAgentPhase(ctx, {
      phase: PhaseName('implement'),
      profile: 'full' as never,
      step: 'implement',
      vars: {},
      agentContract: {},
      skipResultExtraction: true,
    });

    expect(result.outcome).toBe('passed');
  });
});
