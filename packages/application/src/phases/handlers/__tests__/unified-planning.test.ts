import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { PlanDesignHandler } from '../plan-design.js';
import { PlanWriteHandler } from '../plan-write.js';
import { PlanReviewHandler } from '../plan-review.js';
import { FakeAgentPort } from '../../../test-doubles/fake-agent-port.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import { FakeGitHubPort } from '../../../test-doubles/fake-github-port.js';
import type { AgentInvocationResult } from '../../../ports/agent-invocation-types.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { PlanReviewLoop } from '../../../plan-review/plan-review-loop.js';
import type { PlanReviewLoopResult } from '../../../plan-review/types.js';
import { PhaseName } from '@ai-sdlc/domain';

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
    runId: 'run-1092',
    runUuid: '10921092-1092-1092-1092-109210921092',
    repoFullName: 'acme/widgets',
    issueNumber: 1092,
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
    startCommitSha: overrides?.startCommitSha ?? 'abc1234567890',
    expectedBranch: overrides?.expectedBranch ?? 'main',
    resolveProfile:
      (overrides?.resolveProfile as PhaseHandlerContext['resolveProfile']) ??
      (() => 'opencode-frontier'),
    idFactory: overrides?.idFactory ?? (() => 'inv-1092'),
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

describe('Unified Planning (Issue #1092)', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx({ executionPolicy: 'standard' });
    seedGit(ctx);
    mockLoadPromptTemplate.mockReturnValue('# Unified Planner Prompt\n\n{{artifact:issue.md}}');
    mockRenderPrompt.mockResolvedValue('# Unified Planner Prompt Rendered\n\n# Issue 1092');
  });

  it('standard planning requires exactly one successful LLM invocation and writes design.md and plan.md via application store', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Issue 1092\n\nSingle unified planner invocation\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    const validPackage = {
      design_md: '# Design Document\n\nArchitecture details.',
      plan_md:
        '# Implementation Plan\n\n## Task 1: Setup component\nDetails.\n\n## Task 2: Add tests\nDetails.',
    };

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify(validPackage),
    });

    // 1. Plan-design executes single-shot planner
    const designHandler = new PlanDesignHandler();
    const designResult = await designHandler.run(ctx);

    expect(designResult.outcome).toBe('passed');
    expect(agent.invocations).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-design.started')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-design.completed')).toHaveLength(1);

    // Verify canonical artifacts written by application (design.md and plan.md; no task-manifest.json)
    const artifacts = await ctx.artifacts.list(ctx.runUuid);
    const designArt = artifacts.find((a) => a.relativePath === 'design.md');
    const planArt = artifacts.find((a) => a.relativePath === 'plan.md');
    const manifestArt = artifacts.find((a) => a.relativePath === 'task-manifest.json');

    expect(designArt).toBeDefined();
    expect(planArt).toBeDefined();
    expect(manifestArt).toBeUndefined();

    expect(await ctx.artifacts.read(ctx.runUuid, 'design.md')).toBe(validPackage.design_md);
    expect(await ctx.artifacts.read(ctx.runUuid, 'plan.md')).toBe(validPackage.plan_md);

    // 2. Plan-write runs: reuses existing artifacts and makes 0 agent calls
    const writeHandler = new PlanWriteHandler();
    const writeResult = await writeHandler.run(ctx);

    expect(writeResult.outcome).toBe('passed');
    expect(agent.invocations).toHaveLength(1); // Still exactly 1 invocation total!
    expect(eventsOf(ctx, 'plan-write.completed')).toHaveLength(1);

    // 3. Plan-review runs: skipped under standard policy (0 agent calls)
    const mockLoop = {
      execute: vi.fn(),
    } as unknown as PlanReviewLoop;
    const reviewHandler = new PlanReviewHandler({
      loop: mockLoop,
      enabled: true,
      maxIterations: 3,
    });
    const reviewResult = await reviewHandler.run(ctx);

    expect(reviewResult.outcome).toBe('passed');
    expect(mockLoop.execute).not.toHaveBeenCalled();
    expect(agent.invocations).toHaveLength(1); // Still exactly 1 invocation total across all planning phases!
    expect(eventsOf(ctx, 'plan-review.skipped')).toHaveLength(1);
  });

  it('deterministic checks reject malformed planning output without invoking reviewer or fixer agents', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Issue 1092\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    // Incoherent plan: unclosed code fence
    const invalidPackage = {
      design_md: '# Design\n\nSome design.',
      plan_md: '# Plan\n\n## Task 1: Setup\n```ts\nconst x = 1;\n',
    };

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify(invalidPackage),
    });

    const handler = new PlanDesignHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
      expect(result.failure.message).toContain('Deterministic plan check failed');
    }
    // Only 1 invocation occurred; no reviewer or fixer loops were called
    expect(agent.invocations).toHaveLength(1);
  });

  it('deterministic checks reject non-JSON or invalid schema result without invoking reviewer agents', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Issue 1092\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: '{"design_md": "Only design, missing plan_md"}',
    });

    const handler = new PlanDesignHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
      expect(result.failure.message).toContain('Result extraction failed');
    }
    expect(agent.invocations).toHaveLength(1);
  });

  it('strict mode caps plan-review at 1 iteration and disables bonus iterations', async () => {
    const strictCtx = makeCtx({ executionPolicy: 'strict' });
    seedGit(strictCtx);

    await strictCtx.artifacts.write({
      runId: strictCtx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Setup\nDetails.',
    });

    const mockLoop = {
      execute: vi.fn(
        async (input: {
          maxIterations: number;
          options?: { bonusIteration?: boolean; deltaScopedReReview?: boolean };
        }) => {
          expect(input.maxIterations).toBe(1);
          expect(input.options?.bonusIteration).toBe(false);
          expect(input.options?.deltaScopedReReview).toBe(false);
          return {
            loop: {
              id: 'l-strict',
              runId: strictCtx.runUuid as never,
              phaseId: PhaseName('plan-review'),
              type: 'plan-review',
              maxIterations: 1,
              iterations: [],
              status: 'running',
              startedAt: new Date(),
            },
            outcome: 'success',
            proceedWithConcerns: false,
          } as unknown as PlanReviewLoopResult;
        },
      ),
    } as unknown as PlanReviewLoop;

    const reviewHandler = new PlanReviewHandler({
      loop: mockLoop,
      enabled: true,
      maxIterations: 3,
    });
    const result = await reviewHandler.run(strictCtx);

    expect(result.outcome).toBe('passed');
    expect(mockLoop.execute).toHaveBeenCalledTimes(1);
  });

  it('resume/retry idempotently reuses existing canonical planning artifacts', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Existing Design',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Existing Plan',
    });

    const agent = ctx.agent as FakeAgentPort;
    const handler = new PlanDesignHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(agent.invocations).toHaveLength(0); // Zero agent calls when resuming with existing artifacts!
    expect(eventsOf(ctx, 'plan-design.completed')).toHaveLength(1);
  });
});
