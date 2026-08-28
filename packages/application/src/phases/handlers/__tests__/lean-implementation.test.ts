import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler, type StepRunContext, type StepRunResult } from '../implement.js';
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
  let runStepMock: ReturnType<typeof vi.fn<(sctx: StepRunContext) => Promise<StepRunResult>>>;

  const validPlanMd = `# Implementation Plan

## Task 1: Setup auth service
Create authentication service.

## Task 2: Add login endpoint
Add login route and handler.`;

  const validManifest = {
    version: 2,
    task_count: 2,
    tasks: [
      {
        n: 1,
        title: 'Setup auth service',
        task_type: 'standard',
        expected_files: ['src/auth/service.ts'],
        reference_files: ['src/config.ts'],
      },
      {
        n: 2,
        title: 'Add login endpoint',
        task_type: 'standard',
        expected_files: ['src/routes/login.ts'],
        reference_files: [],
      },
    ],
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    ctx = makeCtx({ executionPolicy: 'standard' });
    seedGit(ctx);
    steps = new FakeStepRepository();
    runStepMock = vi.fn();

    mockLoadPromptTemplate.mockReturnValue('# Implement Prompt\n\n{{artifact:plan.md}}');
    mockRenderPrompt.mockResolvedValue('# Rendered Implement Prompt');

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-write',
      relativePath: 'plan.md',
      contents: validPlanMd,
    });
  });

  it('standard policy uses exactly one implementation invocation and bypasses runStep/task reviews', async () => {
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
      runStep: runStepMock,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(agent.invocations.length).toBe(1);
    expect(runStepMock).not.toHaveBeenCalled();

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

  it('strict policy also uses single-shot implementation invocation and bypasses runStep', async () => {
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
      runStep: runStepMock,
    });

    const result = await handler.run(strictCtx);

    expect(result.outcome).toBe('passed');
    expect(agent.invocations.length).toBe(1);
    expect(runStepMock).not.toHaveBeenCalled();
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
      runStep: runStepMock,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(agent.invocations.length).toBe(0);
    expect(runStepMock).not.toHaveBeenCalled();

    const skippedEvents = eventsOf(ctx, 'step.skipped');
    expect(skippedEvents.length).toBe(1);
  });

  it('allows newly discovered helpers, callers, tests, and fixtures without manifest scope rejection', async () => {
    const git = ctx.git as FakeGitPort;
    const preSha = '0'.repeat(40);
    const postSha = '1'.repeat(40);
    git.changedFilesResults.set(`${preSha}|${postSha}`, [
      'src/auth/service.ts',
      'src/auth/helpers/token.ts',
      'src/routes/caller.ts',
      'test/fixtures/auth-data.json',
      'test/regression/new-coverage.test.ts',
    ]);

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', () => {
      git.headByCwd.set(ctx.cwd, postSha);
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
      runStep: runStepMock,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    const persistedSteps = steps.listForRun(ctx.runUuid as RunId);
    expect(persistedSteps[0]?.status).toBe('success');
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
      runStep: runStepMock,
    });

    const result = await handler.run(inboundCtx);

    expect(result.outcome).toBe('failed');
    expect(result.failure?.kind).toBe('phase_boundary_violation');
    expect(agent.invocations.length).toBe(0);
  });

  it('legacy execution policy continues to use multi-task runStep iteration', async () => {
    const legacyCtx = makeCtx({ executionPolicy: 'legacy' });
    seedGit(legacyCtx);
    await legacyCtx.artifacts.write({
      runId: legacyCtx.runUuid,
      phaseId: 'plan-write',
      relativePath: 'plan.md',
      contents: validPlanMd,
    });
    await legacyCtx.artifacts.write({
      runId: legacyCtx.runUuid,
      phaseId: 'plan-write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(validManifest),
    });

    const git = legacyCtx.git as FakeGitPort;
    const preSha = '0'.repeat(40);
    const postSha1 = 'fake-sha-1';
    const postSha2 = 'fake-sha-2';

    runStepMock.mockImplementation(async (sctx) => {
      if (sctx.stepIndex === 1) {
        git.headByCwd.set(legacyCtx.cwd, postSha1);
        git.changedFilesResults.set(`${preSha}|${postSha1}`, ['src/auth/service.ts']);
      } else if (sctx.stepIndex === 2) {
        git.headByCwd.set(legacyCtx.cwd, postSha2);
        git.changedFilesResults.set(`${postSha1}|${postSha2}`, ['src/routes/login.ts']);
      }
      return { outcome: 'success' };
    });

    const handler = new ImplementHandler({
      steps,
      runStep: runStepMock,
    });

    const result = await handler.run(legacyCtx);

    expect(result.outcome).toBe('passed');
    expect(runStepMock).toHaveBeenCalledTimes(2);
    expect(runStepMock).toHaveBeenCalledWith(
      expect.objectContaining({ stepIndex: 1, stepTitle: 'Task 1: Setup auth service' }),
    );
    expect(runStepMock).toHaveBeenCalledWith(
      expect.objectContaining({ stepIndex: 2, stepTitle: 'Task 2: Add login endpoint' }),
    );
  });

  it('marks step failed and returns failure when agent invocation fails', async () => {
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult({ outcome: 'failed', exitCode: 1 }));

    const handler = new ImplementHandler({
      steps,
      runStep: runStepMock,
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
      runStep: runStepMock,
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
      runStep: runStepMock,
      setup: setupMock,
    });

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    expect(result.failure?.kind).toBe('setup_failed');
    expect(setupMock).toHaveBeenCalled();
  });
});
