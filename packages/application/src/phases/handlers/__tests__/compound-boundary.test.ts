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

function makeCtx(): PhaseHandlerContext & { _events: OrchestratorEvent[] } {
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
    promptsRoot: '/tmp/prompts',
    startCommitSha: 'abc123',
    expectedBranch: 'main',
    baseBranch: 'main',
    resolveProfile: () => 'pi-qwen-local',
    idFactory: () => 'inv-001',
    _events: events,
  } as unknown as PhaseHandlerContext & { _events: OrchestratorEvent[] };
}

function eventsOf(
  ctx: PhaseHandlerContext & { _events: OrchestratorEvent[] },
  type: string,
): OrchestratorEvent[] {
  return ctx._events.filter((e) => e.type === type);
}

describe('CompoundHandler task boundary enforcement (regression)', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx();
    const git = ctx.git as FakeGitPort;
    git.currentBranchByCwd.set(ctx.cwd, 'main');
    git.headByCwd.set(ctx.cwd, 'sha-before');
    mockLoadPromptTemplate.mockReturnValue('# Learnings');
    mockRenderPrompt.mockResolvedValue('# Learnings for 42');
  });

  it('fails phase and emits violation when compound agent commits undeclared files', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan_write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'Task 1', expected_files: ['src/declared.ts'] }],
      }),
    });

    const git = ctx.git as FakeGitPort;
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('pi-qwen-local', () => {
      git.headByCwd.set(ctx.cwd, 'sha-after');
      return successResult();
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'written', path: 'compound.md', summary: 'ok' }),
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'compound.md',
      contents: '# Learnings\n',
    });

    git.changedFilesResults.set('sha-before|sha-after', ['src/undeclared.ts']);

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.message).toContain(
        'compound phase modified undeclared files: src/undeclared.ts',
      );
    }
    expect(eventsOf(ctx, 'compound.boundary_violation')).toHaveLength(1);
    expect(eventsOf(ctx, 'compound.completed')).toHaveLength(0);
  });

  it('passes and emits compound.completed once when compound agent commits only declared files', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan_write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'Task 1', expected_files: ['src/declared.ts'] }],
      }),
    });

    const git = ctx.git as FakeGitPort;
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('pi-qwen-local', () => {
      git.headByCwd.set(ctx.cwd, 'sha-after');
      return successResult();
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'written', path: 'compound.md', summary: 'ok' }),
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'compound.md',
      contents: '# Learnings\n',
    });

    git.changedFilesResults.set('sha-before|sha-after', ['src/declared.ts']);

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(eventsOf(ctx, 'compound.completed')).toHaveLength(1);
  });

  it('fails phase and emits violation when compound agent modifies reference files', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan_write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [
          {
            n: 1,
            title: 'Task 1',
            expected_files: ['src/declared.ts'],
            reference_files: ['docs/ref.md'],
          },
        ],
      }),
    });

    const git = ctx.git as FakeGitPort;
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('pi-qwen-local', () => {
      git.headByCwd.set(ctx.cwd, 'sha-after');
      return successResult();
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'written', path: 'compound.md', summary: 'ok' }),
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'compound.md',
      contents: '# Learnings\n',
    });

    git.changedFilesResults.set('sha-before|sha-after', ['docs/ref.md']);

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('validation_failed');
      expect(result.failure.message).toContain(
        'compound phase modified undeclared files: docs/ref.md',
      );
    }
    expect(eventsOf(ctx, 'compound.boundary_violation')).toHaveLength(1);
    expect(eventsOf(ctx, 'compound.completed')).toHaveLength(0);
  });

  it('fails phase with git_failed when git.changedFiles throws', async () => {
    const git = ctx.git as FakeGitPort;
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('pi-qwen-local', () => {
      git.headByCwd.set(ctx.cwd, 'sha-after');
      return successResult();
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'written', path: 'compound.md', summary: 'ok' }),
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'compound.md',
      contents: '# Learnings\n',
    });

    git.changedFiles = vi.fn().mockRejectedValue(new Error('git diff-tree failed'));

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('git_failed');
      expect(result.failure.message).toContain(
        'Failed to check changed files in compound phase: git diff-tree failed',
      );
    }
    expect(eventsOf(ctx, 'compound.failed')).toHaveLength(1);
    expect(eventsOf(ctx, 'compound.completed')).toHaveLength(0);
  });

  it('passes when manifest is missing or invalid JSON', async () => {
    const git = ctx.git as FakeGitPort;
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('pi-qwen-local', () => {
      git.headByCwd.set(ctx.cwd, 'sha-after');
      return successResult();
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'written', path: 'compound.md', summary: 'ok' }),
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'compound.md',
      contents: '# Learnings\n',
    });

    git.changedFilesResults.set('sha-before|sha-after', ['src/anything.ts']);

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(eventsOf(ctx, 'compound.completed')).toHaveLength(1);
  });

  it('passes when no commits were created during compound phase', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan_write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        task_count: 1,
        tasks: [{ n: 1, title: 'Task 1', expected_files: ['src/declared.ts'] }],
      }),
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('pi-qwen-local', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'written', path: 'compound.md', summary: 'ok' }),
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'compound.md',
      contents: '# Learnings\n',
    });

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(eventsOf(ctx, 'compound.completed')).toHaveLength(1);
  });
});
