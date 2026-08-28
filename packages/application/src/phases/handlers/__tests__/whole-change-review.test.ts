import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ReviewFixHandler } from '../review-fix.js';
import { FakeAgentPort } from '../../../test-doubles/fake-agent-port.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import { FakeGitHubPort } from '../../../test-doubles/fake-github-port.js';
import type { AgentInvocationResult } from '../../../ports/agent-invocation-types.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { RunValidation } from '../../../run-validation.js';

const { mockLoadPromptTemplate, mockRenderPrompt } = vi.hoisted(() => ({
  mockLoadPromptTemplate: vi.fn<[string, string, { promptsRoot: string }], string>(),
  mockRenderPrompt: vi.fn<
    [
      string,
      {
        runId: string;
        vars: Record<string, string>;
        artifacts: PhaseHandlerContext['artifacts'];
      },
    ],
    Promise<string>
  >(),
}));

vi.mock('../../../prompts/load-prompt-template.js', () => ({
  loadPromptTemplate: mockLoadPromptTemplate,
}));

vi.mock('../../../prompts/render-prompt.js', () => ({
  renderPrompt: mockRenderPrompt,
}));

function successResult(overrides?: Partial<AgentInvocationResult>): AgentInvocationResult {
  return {
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    exitCode: 0,
    durationMs: 5000,
    stdoutPath: '/tmp/stdout',
    stderrPath: '/tmp/stderr',
    resultJsonPath: 'result.json',
    contractViolations: [],
    outcome: 'success',
    ...overrides,
  };
}

function makeCtx(overrides?: {
  executionPolicy?: 'legacy' | 'standard' | 'strict';
  promptsRoot?: string;
  startCommitSha?: string;
  expectedBranch?: string;
  resolveProfile?: (p: string) => string;
  idFactory?: () => string;
}): PhaseHandlerContext & { _events: OrchestratorEvent[] } {
  const events: OrchestratorEvent[] = [];
  const now = () => new Date('2026-08-28T00:00:00Z');
  return {
    runId: 'run-1094',
    runUuid: '10941094-1094-1094-1094-109410941094',
    repoFullName: 'acme/widgets',
    issueNumber: 1094,
    cwd: '/tmp/wt',
    executionPolicy: overrides?.executionPolicy ?? 'standard',
    artifacts: new FakeArtifactStore(),
    github: new FakeGitHubPort(),
    git: new FakeGitPort(),
    agent: new FakeAgentPort(),
    events: {
      publish: (_u: string, e: OrchestratorEvent) => {
        events.push(e);
      },
      subscribe: () => () => {},
    },
    now,
    promptsRoot: overrides?.promptsRoot ?? '/tmp/prompts',
    startCommitSha: overrides?.startCommitSha ?? '0'.repeat(40),
    expectedBranch: overrides?.expectedBranch ?? 'main',
    resolveProfile:
      (overrides?.resolveProfile as PhaseHandlerContext['resolveProfile']) ??
      (() => 'opencode-frontier'),
    idFactory: overrides?.idFactory ?? (() => 'inv-1094'),
    _events: events,
  } as unknown as PhaseHandlerContext & { _events: OrchestratorEvent[] };
}

function seedGit(ctx: PhaseHandlerContext) {
  const git = ctx.git as FakeGitPort;
  git.currentBranchByCwd.set(ctx.cwd, ctx.expectedBranch ?? 'main');
  git.headByCwd.set(ctx.cwd, ctx.startCommitSha ?? '0'.repeat(40));
}

function eventsOf(
  ctx: PhaseHandlerContext & { _events: OrchestratorEvent[] },
  type: string,
): OrchestratorEvent[] {
  return ctx._events.filter((e) => e.type === type);
}

describe('Authoritative Grounded Whole-Change Review (Issue #1094)', () => {
  let ctx: ReturnType<typeof makeCtx>;
  let legacyRunLoopMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    ctx = makeCtx({ executionPolicy: 'standard' });
    seedGit(ctx);
    legacyRunLoopMock = vi.fn();

    mockLoadPromptTemplate.mockReturnValue(
      '# Whole Change Review\n\n{{artifact:issue.md}}\n{{artifact:design.md}}\n{{artifact:plan.md}}\n{{artifact:task-manifest.json}}\n{{var:complete_diff}}\n{{var:validation_evidence}}',
    );
    mockRenderPrompt.mockResolvedValue('# Rendered Whole Change Review Prompt');

    // Seed artifacts
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents:
        '# Issue 1094\n\n## Acceptance Criteria\n- One whole-change review pass\n- Structured verdict',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design Document\n\nAnchored design details.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-write',
      relativePath: 'plan.md',
      contents: '# Implementation Plan\n\n## Task 1: Review setup',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'Review setup' }],
      }),
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'validate',
      relativePath: 'validation.result',
      contents: 'passed\n',
    });
  });

  it('performs exactly one whole-change review invocation under standard policy when validation succeeds and APPROVE is returned', async () => {
    const fakeAgent = ctx.agent as FakeAgentPort;
    fakeAgent.enqueue('opencode-frontier', successResult());

    // Agent writes result.json
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        acceptance_criteria: [
          { criterion: 'One whole-change review pass', result: 'PASS', evidence: 'Verified' },
          { criterion: 'Structured verdict', result: 'PASS', evidence: 'Verified' },
        ],
        findings: [],
        summary: 'All requirements satisfied.',
      }),
    });

    const handler = new ReviewFixHandler({ runLoop: legacyRunLoopMock });
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(fakeAgent.invocations).toHaveLength(1);
    expect(legacyRunLoopMock).not.toHaveBeenCalled();

    const startEvents = eventsOf(ctx, 'review_fix.started');
    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]?.metadata?.policy).toBe('standard');

    const completedEvents = eventsOf(ctx, 'review_fix.completed');
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.metadata?.verdict).toBe('APPROVE');

    // Confirms code-review.md and whole-change-review.json were persisted
    const codeReview = await ctx.artifacts.read(ctx.runUuid, 'code-review.md');
    expect(codeReview).toContain('**Verdict:** APPROVE');
    expect(codeReview).toContain('[PASS] One whole-change review pass');

    const wholeChangeJson = await ctx.artifacts.read(ctx.runUuid, 'whole-change-review.json');
    expect(JSON.parse(wholeChangeJson).verdict).toBe('APPROVE');
  });

  it('grounds prompt with issue truth, planning artifacts, diff, and validation evidence', async () => {
    const fakeAgent = ctx.agent as FakeAgentPort;
    fakeAgent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        acceptance_criteria: [{ criterion: 'Check 1', result: 'PASS' }],
        findings: [],
      }),
    });

    const handler = new ReviewFixHandler({ runLoop: legacyRunLoopMock });
    await handler.run(ctx);

    expect(mockRenderPrompt).toHaveBeenCalled();
    const renderCall = mockRenderPrompt.mock.calls[0];
    expect(renderCall?.[1].vars.validation_evidence).toContain('passed');
    expect(renderCall?.[1].vars.complete_diff).toBeDefined();
    expect(renderCall?.[1].vars.issue_number).toBe('1094');
  });

  it('rejects approval and forces REQUEST_CHANGES if acceptance criteria are empty (anti-trap)', async () => {
    const fakeAgent = ctx.agent as FakeAgentPort;
    fakeAgent.enqueue('opencode-frontier', successResult());
    fakeAgent.enqueue('opencode-frontier', successResult());

    // Agent attempts empty approval without criteria verification
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        acceptance_criteria: [],
        findings: [],
      }),
    });

    const handler = new ReviewFixHandler({ runLoop: legacyRunLoopMock });
    await handler.run(ctx);

    const changeReqEvents = eventsOf(ctx, 'review_fix.changes_requested');
    expect(changeReqEvents).toHaveLength(1);
    expect(changeReqEvents[0]?.metadata?.overrideReason).toContain('Empty acceptance criteria');
  });

  it('forces REQUEST_CHANGES if any acceptance criterion is FAIL', async () => {
    const fakeAgent = ctx.agent as FakeAgentPort;
    fakeAgent.enqueue('opencode-frontier', successResult());
    fakeAgent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        acceptance_criteria: [
          { criterion: 'One whole-change review pass', result: 'PASS' },
          { criterion: 'Structured verdict', result: 'FAIL', evidence: 'Schema missing' },
        ],
        findings: [],
      }),
    });

    const handler = new ReviewFixHandler({ runLoop: legacyRunLoopMock });
    await handler.run(ctx);

    const changeReqEvents = eventsOf(ctx, 'review_fix.changes_requested');
    expect(changeReqEvents).toHaveLength(1);
    expect(changeReqEvents[0]?.metadata?.overrideReason).toContain('Acceptance criteria failed');
  });

  it('forces REQUEST_CHANGES if critical or high severity findings exist', async () => {
    const fakeAgent = ctx.agent as FakeAgentPort;
    fakeAgent.enqueue('opencode-frontier', successResult());
    fakeAgent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        acceptance_criteria: [{ criterion: 'Check 1', result: 'PASS' }],
        findings: [
          {
            severity: 'high',
            files: ['packages/application/src/ports.ts'],
            evidence: "import from '@ai-sdlc/infrastructure'",
            rationale: 'Layer boundary violation',
            minimal_correction: 'Move import to compose root',
          },
        ],
      }),
    });

    const handler = new ReviewFixHandler({ runLoop: legacyRunLoopMock });
    await handler.run(ctx);

    const changeReqEvents = eventsOf(ctx, 'review_fix.changes_requested');
    expect(changeReqEvents).toHaveLength(1);
    expect(changeReqEvents[0]?.metadata?.overrideReason).toContain('Blocking findings present');
  });

  it('permits APPROVE when low-severity (non-blocking) findings exist and all criteria pass', async () => {
    const fakeAgent = ctx.agent as FakeAgentPort;
    fakeAgent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'APPROVE',
        acceptance_criteria: [{ criterion: 'Check 1', result: 'PASS' }],
        findings: [
          {
            severity: 'low',
            files: ['README.md'],
            evidence: 'Doc typo',
            rationale: 'Minor style improvement',
            minimal_correction: 'Fix spelling',
            blocking: false,
          },
        ],
      }),
    });

    const handler = new ReviewFixHandler({ runLoop: legacyRunLoopMock });
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    const completedEvents = eventsOf(ctx, 'review_fix.completed');
    expect(completedEvents).toHaveLength(1);
  });

  it('enters single targeted fix pass on REQUEST_CHANGES and advances when deterministic validation passes', async () => {
    const fakeAgent = ctx.agent as FakeAgentPort;
    // First invocation: review requests changes
    fakeAgent.enqueue('opencode-frontier', successResult());
    // Second invocation: targeted fixer runs
    fakeAgent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        acceptance_criteria: [{ criterion: 'Check 1', result: 'FAIL', evidence: 'Bug' }],
        findings: [
          {
            severity: 'high',
            files: ['src/fix.ts'],
            evidence: 'Null dereference',
            rationale: 'Throws TypeError',
            minimal_correction: 'Add null check',
          },
        ],
      }),
    });

    const mockRunValidation = {
      execute: vi
        .fn()
        .mockResolvedValue({ passed: true, validationRun: { commands: ['pnpm test'] } }),
    } as unknown as RunValidation;

    const handler = new ReviewFixHandler({
      runLoop: legacyRunLoopMock,
      revalidate: {
        runValidation: mockRunValidation,
        commands: ['pnpm test'],
        timeoutSeconds: 60,
        logDir: '/tmp/logs',
      },
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    // Reviewer (1) + Fixer (2) = 2 total agent calls
    expect(fakeAgent.invocations).toHaveLength(2);
    expect(mockRunValidation.execute).toHaveBeenCalled();

    const targetedFixEvents = eventsOf(ctx, 'review_fix.targeted_fix_started');
    expect(targetedFixEvents).toHaveLength(1);

    const completedEvents = eventsOf(ctx, 'review_fix.completed');
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.message).toContain(
      'targeted fix applied and validated successfully',
    );
  });

  it('fails the run if deterministic validation fails after targeted fix', async () => {
    const fakeAgent = ctx.agent as FakeAgentPort;
    fakeAgent.enqueue('opencode-frontier', successResult());
    fakeAgent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({
        verdict: 'REQUEST_CHANGES',
        acceptance_criteria: [{ criterion: 'Check 1', result: 'FAIL' }],
        findings: [
          {
            severity: 'critical',
            evidence: 'Broken build',
            rationale: 'Syntax error',
            minimal_correction: 'Fix syntax',
          },
        ],
      }),
    });

    const mockRunValidation = {
      execute: vi.fn().mockResolvedValue({
        passed: false,
        failure: {
          runUuid: ctx.runUuid,
          phase: 'review-fix',
          kind: 'validation_failed',
          message: 'pnpm test exited with code 1',
          canRetry: true,
          suggestedAction: 'Fix broken test',
          artifacts: [],
          detectedAt: new Date(),
        },
      }),
    } as unknown as RunValidation;

    const handler = new ReviewFixHandler({
      runLoop: legacyRunLoopMock,
      revalidate: {
        runValidation: mockRunValidation,
        commands: ['pnpm test'],
        timeoutSeconds: 60,
        logDir: '/tmp/logs',
      },
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('validation_failed');
      expect(result.failure.message).toBe('pnpm test exited with code 1');
    }
  });

  it('idempotently reuses existing approved review artifacts on resume', async () => {
    const fakeAgent = ctx.agent as FakeAgentPort;

    // Seed existing review artifacts
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'review-fix',
      relativePath: 'code-review.md',
      contents: '# Whole-Change Review\n\n**Verdict:** APPROVE',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'review-fix',
      relativePath: 'whole-change-review.json',
      contents: JSON.stringify({ verdict: 'APPROVE', acceptance_criteria: [], findings: [] }),
    });

    const handler = new ReviewFixHandler({ runLoop: legacyRunLoopMock });
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(fakeAgent.invocations).toHaveLength(0); // 0 invocations — reused!

    const completedEvents = eventsOf(ctx, 'review_fix.completed');
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.message).toContain('reusing existing review');
  });

  it('delegates to legacy runLoop when executionPolicy is legacy', async () => {
    ctx = makeCtx({ executionPolicy: 'legacy' });
    legacyRunLoopMock.mockResolvedValue({
      phaseOutcome: 'passed',
      loopStatus: 'converged',
    });

    const handler = new ReviewFixHandler({ runLoop: legacyRunLoopMock });
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(legacyRunLoopMock).toHaveBeenCalled();
  });
});
