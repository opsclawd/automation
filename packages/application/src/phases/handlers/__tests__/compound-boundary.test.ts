import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { PhaseName } from '@ai-sdlc/domain';
import { CompoundHandler } from '../compound.js';
import { SingleShotAgentHandler } from '../single-shot-agent-handler.js';
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
    startCommitSha: 'sha-before',
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

  it('passes and emits warning event when manifest is missing or invalid JSON', async () => {
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
    const warnEvents = eventsOf(ctx, 'compound.manifest_read_failed');
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]?.level).toBe('warn');
  });

  it('passes when no commits were created and no uncommitted source files exist', async () => {
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

  it('fails phase and emits violation when compound agent leaves uncommitted undeclared files', async () => {
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
      // Uncommitted untracked or modified file
      git.statusByCwd.set(ctx.cwd, '?? src/undeclared-uncommitted.ts');
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

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('validation_failed');
      expect(result.failure.message).toContain(
        'compound phase modified undeclared files: src/undeclared-uncommitted.ts',
      );
    }
    expect(eventsOf(ctx, 'compound.boundary_violation')).toHaveLength(1);
    expect(eventsOf(ctx, 'compound.completed')).toHaveLength(0);
  });

  it('fails phase and emits violation when compound agent leaves uncommitted reference files', async () => {
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
      git.statusByCwd.set(ctx.cwd, ' M docs/ref.md');
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

  it('fails phase when combining committed declared files with uncommitted undeclared files', async () => {
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
      git.statusByCwd.set(ctx.cwd, '?? src/sneak.ts');
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

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('validation_failed');
      expect(result.failure.message).toContain(
        'compound phase modified undeclared files: src/sneak.ts',
      );
    }
    expect(eventsOf(ctx, 'compound.boundary_violation')).toHaveLength(1);
    expect(eventsOf(ctx, 'compound.completed')).toHaveLength(0);
  });

  it('passes when compound agent leaves uncommitted changes only to declared files', async () => {
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
      git.statusByCwd.set(ctx.cwd, ' M src/declared.ts');
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

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(eventsOf(ctx, 'compound.completed')).toHaveLength(1);
  });

  it('passes when compound agent only creates orchestrator artifacts in worktree', async () => {
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
      git.statusByCwd.set(ctx.cwd, '?? compound.md\n?? result.json');
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

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(eventsOf(ctx, 'compound.completed')).toHaveLength(1);
  });

  it('fails phase with git_failed when git.status throws', async () => {
    const git = ctx.git as FakeGitPort;
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

    git.status = vi.fn().mockRejectedValue(new Error('git status failed'));

    const handler = new CompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('git_failed');
      expect(result.failure.message).toContain(
        'Failed to check git status in compound phase: git status failed',
      );
    }
    expect(eventsOf(ctx, 'compound.failed')).toHaveLength(1);
    expect(eventsOf(ctx, 'compound.completed')).toHaveLength(0);
  });

  it('evaluates net diff from ctx.startCommitSha across phase resumption', async () => {
    // Simulate resume scenario: startCommitSha was sha-initial, but HEAD before run() was sha-interim
    ctx.startCommitSha = 'sha-initial';
    const git = ctx.git as FakeGitPort;
    git.headByCwd.set(ctx.cwd, 'sha-interim');

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

    // Diff between sha-initial and sha-after includes undeclared file committed before resume
    git.changedFilesResults.set('sha-initial|sha-after', ['src/undeclared.ts']);
    // Diff between sha-interim and sha-after only has declared file
    git.changedFilesResults.set('sha-interim|sha-after', ['src/declared.ts']);

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

  it('emits warning event when manifest JSON is invalid syntax', async () => {
    const git = ctx.git as FakeGitPort;
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('pi-qwen-local', () => {
      git.headByCwd.set(ctx.cwd, 'sha-after');
      return successResult();
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'task-manifest.json',
      contents: '{ not valid json',
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
    const warnEvents = eventsOf(ctx, 'compound.manifest_read_failed');
    expect(warnEvents).toHaveLength(1);
    expect(warnEvents[0]?.level).toBe('warn');
  });

  it('uses dynamic this.phase in failure and boundary violation events', async () => {
    class CustomCompoundHandler extends CompoundHandler {
      override readonly phase = PhaseName('custom-phase');
    }

    vi.spyOn(SingleShotAgentHandler.prototype, 'run').mockResolvedValue({ outcome: 'passed' });

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
    git.headByCwd.set(ctx.cwd, 'sha-after');

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

    const handler = new CustomCompoundHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.phase).toBe('custom-phase');
      expect(result.failure.message).toContain(
        'custom-phase phase modified undeclared files: src/undeclared.ts',
      );
    }
    expect(eventsOf(ctx, 'custom-phase.boundary_violation')).toHaveLength(1);
    expect(eventsOf(ctx, 'custom-phase.failed')).toHaveLength(1);
  });
});
