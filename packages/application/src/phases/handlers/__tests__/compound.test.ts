import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { CompoundHandler } from '../compound.js';
import { FakeAgentPort } from '../../../test-doubles/fake-agent-port.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import { FakeGitHubPort } from '../../../test-doubles/fake-github-port.js';
import type { AgentInvocationResult } from '../../../ports/agent-invocation-types.js';
import type { PhaseHandlerContext } from '../../handler.js';

const { mockLoadPromptTemplate, mockRenderPrompt } = vi.hoisted(() => ({
  mockLoadPromptTemplate: vi.fn<[string, string, { promptsRoot: string }], string>(),
  mockRenderPrompt: vi.fn<
    [
      string,
      { runId: string; vars: Record<string, string>; artifacts: PhaseHandlerContext['artifacts'] },
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

const PROMPT_TEMPLATE = '# Learnings for {{var:issue_number}}\n\n{{artifact:plan.md}}';
const RENDERED_PROMPT = '# Learnings for 42\n\n# Plan\n\nSome plan.\n';

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
  promptsRoot?: string;
  startCommitSha?: string;
  expectedBranch?: string;
  resolveProfile?: (p: string) => string;
  idFactory?: () => string;
}): PhaseHandlerContext & { _events: OrchestratorEvent[] } {
  const events: OrchestratorEvent[] = [];
  const now = () => new Date('2026-06-16T00:00:00Z');
  return {
    runId: 'run-1',
    runUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    repoFullName: 'acme/widgets',
    issueNumber: 42,
    cwd: '/tmp/wt',
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
    promptsRoot: overrides?.promptsRoot,
    startCommitSha: overrides?.startCommitSha,
    expectedBranch: overrides?.expectedBranch,
    resolveProfile: overrides?.resolveProfile as PhaseHandlerContext['resolveProfile'],
    idFactory: overrides?.idFactory,
    _events: events,
  } as unknown as PhaseHandlerContext & { _events: OrchestratorEvent[] };
}

function seedGit(ctx: PhaseHandlerContext & { _events: OrchestratorEvent[] }) {
  const git = ctx.git as FakeGitPort;
  git.currentBranchByCwd.set(ctx.cwd, (ctx.expectedBranch as string | undefined) ?? 'main');
  git.headByCwd.set(ctx.cwd, (ctx.startCommitSha as string | undefined) ?? '0'.repeat(40));
}

function eventsOf(
  ctx: PhaseHandlerContext & { _events: OrchestratorEvent[] },
  type: string,
): OrchestratorEvent[] {
  return ctx._events.filter((e) => e.type === type);
}

describe('CompoundHandler', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx({
      promptsRoot: '/tmp/prompts',
      startCommitSha: 'abc123',
      expectedBranch: 'main',
      resolveProfile: () => 'pi-qwen-local',
      idFactory: () => 'inv-001',
    });
    seedGit(ctx);
    mockLoadPromptTemplate.mockReturnValue(PROMPT_TEMPLATE);
    mockRenderPrompt.mockResolvedValue(RENDERED_PROMPT);
  });

  it('happy path: invokes agent, validates contract, extracts result', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan_write',
      relativePath: 'plan.md',
      contents: '# Plan\n\nSome plan.',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('pi-qwen-local', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'written',
        path: 'compound.md',
        summary: 'learnings captured',
      }),
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'compound.md',
      contents: '# Learnings\n\nWhat worked: everything.\n',
    });

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');

    expect(agent.invocations).toHaveLength(1);
    const req = agent.invocations[0]!;
    expect(req.profile).toBe('pi-qwen-local');
    expect(req.phaseId).toBe('compound');
    expect(req.expectedArtifacts).toContain('compound.md');
    expect(req.startCommitSha).toBe('abc123');

    expect(eventsOf(ctx, 'compound.started')).toHaveLength(1);
    expect(eventsOf(ctx, 'agent.invoking')).toHaveLength(1);
    expect(eventsOf(ctx, 'artifact.created')).toHaveLength(1);
    expect(eventsOf(ctx, 'compound.completed')).toHaveLength(1);
  });

  it('returns failed when agent outcome is failed (non-throwing)', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan_write',
      relativePath: 'plan.md',
      contents: '# Plan\n\nSome plan.',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('pi-qwen-local', successResult({ outcome: 'failed', exitCode: 1 }));

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('command_failed');
      expect(result.failure.canRetry).toBe(true);
    }
    expect(eventsOf(ctx, 'compound.failed')).toHaveLength(1);
  });

  it('returns blocked when validateAgentContract finds violations (missing compound.md)', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan_write',
      relativePath: 'plan.md',
      contents: '# Plan\n\nSome plan.',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('pi-qwen-local', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'ready', summary: 'ok' }),
    });

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.failure.kind).toBe('agent_contract_violation');
    }
    expect(eventsOf(ctx, 'compound.blocked')).toHaveLength(1);
  });
});
