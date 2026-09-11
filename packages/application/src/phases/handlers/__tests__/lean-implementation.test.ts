import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../implement.js';
import { FakeAgentPort } from '../../../test-doubles/fake-agent-port.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import { FakeGitHubPort } from '../../../test-doubles/fake-github-port.js';
import { FakeStepRepository } from '../../../test-doubles/fake-step-repository.js';
import type { AgentInvocationResult } from '../../../ports/agent-invocation-types.js';
import type { PhaseHandlerContext } from '../../handler.js';
import { PhaseName, RunId } from '@ai-sdlc/domain';

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
    runId: 'run-1093',
    runUuid: '10931093-1093-1093-1093-109310931093',
    repoFullName: 'acme/widgets',
    issueNumber: 1093,
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
    idFactory: overrides?.idFactory ?? (() => 'inv-1093'),
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

describe('Lean Implementation (Issue #1093)', () => {
  let ctx: ReturnType<typeof makeCtx>;
  let steps: FakeStepRepository;

  const validPlanMd = `# Implementation Plan

## Task 1: Setup auth service
Create authentication service.

## Task 2: Add login endpoint
Add login route and handler.`;

  beforeEach(async () => {
    vi.clearAllMocks();
    ctx = makeCtx({ executionPolicy: 'standard' });
    seedGit(ctx);
    steps = new FakeStepRepository();

    mockLoadPromptTemplate.mockReturnValue('# Implement Prompt\n\n{{artifact:plan.md}}');
    mockRenderPrompt.mockResolvedValue('# Rendered Implement Prompt');

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-write',
      relativePath: 'plan.md',
      contents: validPlanMd,
    });
  });

  it('standard policy uses exactly one implementation invocation and executes lean implementation', async () => {
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents:
        'Status: DONE\nImplemented auth and login.\nFiles changed:\n- src/auth/service.ts\n- src/routes/login.ts\n',
    });

    const handler = new ImplementHandler({
      steps,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(agent.invocations.length).toBe(1);

    const startedEvents = eventsOf(ctx, 'step.started');
    expect(startedEvents.length).toBe(1);
    expect((startedEvents[0]?.metadata as { index?: number; policy?: string })?.policy).toBe(
      'standard',
    );

    const completedEvents = eventsOf(ctx, 'step.completed');
    expect(completedEvents.length).toBe(1);
    expect((completedEvents[0]?.metadata as { index?: number; policy?: string })?.policy).toBe(
      'standard',
    );

    const implementCompletedEvents = eventsOf(ctx, 'implement.completed');
    expect(implementCompletedEvents.length).toBe(1);
    expect((implementCompletedEvents[0]?.metadata as { policy?: string })?.policy).toBe('standard');

    const persistedSteps = steps.listForRun(ctx.runUuid as RunId);
    expect(persistedSteps.length).toBe(1);
    expect(persistedSteps[0]?.status).toBe('success');
    expect(persistedSteps[0]?.index).toBe(1);
  });

  it('strict policy also uses single-shot implementation invocation', async () => {
    const strictCtx = makeCtx({ executionPolicy: 'strict' });
    seedGit(strictCtx);
    await strictCtx.artifacts.write({
      runId: strictCtx.runUuid,
      phaseId: 'plan-write',
      relativePath: 'plan.md',
      contents: validPlanMd,
    });
    await strictCtx.artifacts.write({
      runId: strictCtx.runUuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: 'Status: DONE\n',
    });

    const agent = strictCtx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    const handler = new ImplementHandler({
      steps,
    });

    const result = await handler.run(strictCtx);

    expect(result.outcome).toBe('passed');
    expect(agent.invocations.length).toBe(1);
  });

  it('resume idempotency: skips agent invocation when implementation step is already completed', async () => {
    steps.upsert({
      id: `${ctx.runUuid}:implement:1`,
      runId: ctx.runUuid,
      phaseId: PhaseName('implement'),
      index: 1,
      title: 'Implement issue',
      status: 'success',
      startedAt: ctx.now(),
      completedAt: ctx.now(),
      revertCounts: {},
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: 'Status: DONE\n',
    });

    const agent = ctx.agent as FakeAgentPort;

    const handler = new ImplementHandler({
      steps,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(agent.invocations.length).toBe(0);

    const skippedEvents = eventsOf(ctx, 'step.skipped');
    expect(skippedEvents.length).toBe(1);
  });

  it('allows newly discovered helpers, callers, tests, and fixtures without manifest scope rejection', async () => {
    const git = ctx.git as FakeGitPort;
    const preSha = '0'.repeat(40);
    git.headByCwd.set(ctx.cwd, preSha);
    git.statusByCwd.set(
      ctx.cwd,
      ' M src/auth/service.ts\n?? src/auth/helpers/token.ts\n?? test/fixtures/auth-data.json\n',
    );

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', () => {
      return successResult();
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: 'Status: DONE\nImplemented auth with newly discovered helpers and tests.\n',
    });

    const handler = new ImplementHandler({
      steps,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    const persistedSteps = steps.listForRun(ctx.runUuid as RunId);
    expect(persistedSteps[0]?.status).toBe('success');
  });

  it('fails with contract violation when agent creates an unexpected commit under lean policy', async () => {
    const git = ctx.git as FakeGitPort;
    const preSha = '0'.repeat(40);
    const postSha = '1'.repeat(40);
    git.headByCwd.set(ctx.cwd, preSha);

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', () => {
      git.headByCwd.set(ctx.cwd, postSha);
      return successResult();
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: 'Status: DONE\nImplemented changes.\n',
    });

    const handler = new ImplementHandler({
      steps,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.failure.kind).toBe('agent_contract_violation');
      expect(result.failure.message).toContain('unexpected_commit');
    }
  });

  it('inbound worktree cleanliness gate aborts implementation before agent invocation', async () => {
    const git = ctx.git as FakeGitPort;
    git.statusByCwd.set(ctx.cwd, ' M src/dirty.ts');

    const inboundCtx = {
      ...ctx,
      priorPhaseName: 'plan-review',
    } as PhaseHandlerContext & { _events: OrchestratorEvent[] };

    const agent = ctx.agent as FakeAgentPort;

    const handler = new ImplementHandler({
      steps,
    });

    const result = await handler.run(inboundCtx);

    expect(result.outcome).toBe('failed');
    expect(result.failure?.kind).toBe('phase_boundary_violation');
    expect(agent.invocations.length).toBe(0);
  });

  it('legacy execution policy routes to lean implementation', async () => {
    const legacyCtx = makeCtx({ executionPolicy: 'legacy' });
    seedGit(legacyCtx);
    await legacyCtx.artifacts.write({
      runId: legacyCtx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'plan.md',
      contents: validPlanMd,
    });
    await legacyCtx.artifacts.write({
      runId: legacyCtx.runUuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents:
        'Status: DONE\nImplemented auth and login.\nFiles changed:\n- src/auth/service.ts\n- src/routes/login.ts\n',
    });
    const agent = legacyCtx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    const handler = new ImplementHandler({
      steps,
    });

    const result = await handler.run(legacyCtx);

    expect(result.outcome).toBe('passed');
    expect(agent.invocations.length).toBe(1);
  });

  it('marks step failed and returns failure when agent invocation fails', async () => {
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult({ outcome: 'failed', exitCode: 1 }));

    const handler = new ImplementHandler({
      steps,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    const persistedSteps = steps.listForRun(ctx.runUuid as RunId);
    expect(persistedSteps[0]?.status).toBe('failed');
  });

  it('fails when agent violates contract by omitting implementation-log.md', async () => {
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    const handler = new ImplementHandler({
      steps,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('blocked');
    expect(result.failure?.kind).toBe('agent_contract_violation');
    expect(result.failure?.message).toContain('missing_required_artifact');

    const persistedSteps = steps.listForRun(ctx.runUuid as RunId);
    expect(persistedSteps[0]?.status).toBe('failed');
  });

  it('fails when setup fails in lean mode', async () => {
    const setupMock = vi.fn().mockResolvedValue({ ok: false, error: 'pnpm install failed' });

    const handler = new ImplementHandler({
      steps,
      setup: setupMock,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    expect(result.failure?.kind).toBe('setup_failed');
    expect(setupMock).toHaveBeenCalled();
  });

  it('injects SELF_VERIFY_INSTRUCTIONS into implement prompt vars based on selfVerifyCommands', async () => {
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: 'Status: DONE\n',
    });

    const handler = new ImplementHandler({
      steps,
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

  it('injects SELF_VERIFY_INSTRUCTIONS from ctx.selfVerifyCommands when opts.selfVerifyCommands is omitted', async () => {
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: 'Status: DONE\n',
    });

    ctx.selfVerifyCommands = ['pnpm typecheck', 'pnpm test:unit'];

    const handler = new ImplementHandler({
      steps,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    const lastCall = mockRenderPrompt.mock.calls[mockRenderPrompt.mock.calls.length - 1];
    const promptCtx = lastCall?.[1];
    expect(promptCtx?.vars.SELF_VERIFY_INSTRUCTIONS).toContain('- `pnpm typecheck`');
    expect(promptCtx?.vars.SELF_VERIFY_INSTRUCTIONS).toContain('- `pnpm test:unit`');
  });

  it('falls back to default generic SELF_VERIFY_INSTRUCTIONS when selfVerifyCommands is not configured', async () => {
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: 'Status: DONE\n',
    });

    const handler = new ImplementHandler({
      steps,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    const lastCall = mockRenderPrompt.mock.calls[mockRenderPrompt.mock.calls.length - 1];
    const promptCtx = lastCall?.[1];
    expect(promptCtx?.vars.SELF_VERIFY_INSTRUCTIONS).toBe(
      'Limit your own verification to: typecheck and lint for the files you changed, plus only the specific unit test(s) that directly cover them.',
    );
  });
});
