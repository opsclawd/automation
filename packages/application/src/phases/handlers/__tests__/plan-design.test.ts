import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { PlanDesignHandler } from '../plan-design.js';
import { FakeAgentPort } from '../../../test-doubles/fake-agent-port.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import { FakeGitHubPort } from '../../../test-doubles/fake-github-port.js';
import type { AgentInvocationResult } from '../../../ports/agent-invocation-types.js';
import type { PhaseHandlerContext, PhaseHandler } from '../../handler.js';
import { TemplateError, TemplateNotFoundError } from '../../../prompts/errors.js';

// ---------------------------------------------------------------------------
// Mock loadPromptTemplate to avoid filesystem dependency. Tests exercise the
// helper's integration of the other real functions (renderPrompt,
// validateAgentContract, extractResult) at the AgentPort boundary.
//
// NOTE: vi.mock() is hoisted to the top of the module. We use vi.hoisted()
// to ensure the mock function variables are initialized before the hoisted
// factory callbacks reference them.
// ---------------------------------------------------------------------------
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

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROMPT_TEMPLATE = '# Plan design for issue {{var:issue_number}}\n\n{{artifact:issue.md}}';
const RENDERED_PROMPT = '# Plan design for issue 42\n\n# Test Issue\n\nBody text.\n';

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

// ---------------------------------------------------------------------------
// PlanDesignHandler — happy path
// ---------------------------------------------------------------------------

describe('PlanDesignHandler', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx({
      promptsRoot: '/tmp/prompts',
      startCommitSha: 'abc123',
      expectedBranch: 'main',
      resolveProfile: () => 'opencode-frontier',
      idFactory: () => 'inv-001',
    });
    seedGit(ctx);
    mockLoadPromptTemplate.mockReturnValue(PROMPT_TEMPLATE);
    mockRenderPrompt.mockResolvedValue(RENDERED_PROMPT);
  });

  it('happy path: invokes agent, validates contract, extracts result', async () => {
    // Seed required input artifact (issue.md) for renderPrompt
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Test Issue\n\nBody text.\n',
    });

    // Seed the agent to return success with a valid result.json
    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    // Seed result.json in artifact store (simulates agent writing it)
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'ready',
        summary: 'design is ready',
      }),
    });

    // Seed design.md and plan.md (the required output artifacts)
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design\n\nSome design content.',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\nSome plan content.',
    });

    const handler = new PlanDesignHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');

    // Verify agent was invoked with correct request shape
    expect(agent.invocations).toHaveLength(1);
    expect(agent.invocations[0]).toBeDefined();
    const req = agent.invocations[0]!;
    expect(req.profile).toBe('opencode-frontier');
    expect(req.phaseId).toBe('plan-design');
    expect(req.expectedArtifacts).toContain('design.md');
    expect(req.startCommitSha).toBe('abc123');

    // Verify lifecycle events
    expect(eventsOf(ctx, 'plan-design.started')).toHaveLength(1);
    expect(eventsOf(ctx, 'agent.invoking')).toHaveLength(1);
    expect(eventsOf(ctx, 'artifact.created')).toHaveLength(1); // prompt.md
    expect(eventsOf(ctx, 'plan-design.completed')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Shared helper error paths
// ---------------------------------------------------------------------------

describe('runSingleShotAgentPhase error paths - PlanDesignHandler', () => {
  let ctx: ReturnType<typeof makeCtx>;
  let handler: PhaseHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new PlanDesignHandler();
  });

  function setupCtx(overrides?: Parameters<typeof makeCtx>[0]) {
    ctx = makeCtx(
      overrides ?? {
        promptsRoot: '/tmp/prompts',
        startCommitSha: 'abc123',
        expectedBranch: 'main',
        resolveProfile: () => 'opencode-frontier',
        idFactory: () => 'inv-001',
      },
    );
    seedGit(ctx);
    mockLoadPromptTemplate.mockReturnValue(PROMPT_TEMPLATE);
    mockRenderPrompt.mockResolvedValue(RENDERED_PROMPT);
  }

  it('returns failed when promptsRoot is missing', async () => {
    setupCtx({
      startCommitSha: 'abc123',
      expectedBranch: 'main',
      resolveProfile: () => 'pf',
    });
    ctx.promptsRoot = undefined as unknown as string;
    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('command_failed');
    }
  });

  it('returns failed when startCommitSha is missing', async () => {
    setupCtx({
      promptsRoot: '/p',
      expectedBranch: 'main',
      resolveProfile: () => 'pf',
    });
    ctx.startCommitSha = undefined as unknown as string;
    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('command_failed');
    }
  });

  it('returns failed when expectedBranch is missing', async () => {
    setupCtx({
      promptsRoot: '/p',
      startCommitSha: 'abc',
      resolveProfile: () => 'pf',
    });
    ctx.expectedBranch = undefined as unknown as string;
    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('command_failed');
    }
  });

  it('returns failed when resolveProfile is missing from context', async () => {
    setupCtx({
      promptsRoot: '/p',
      startCommitSha: 'abc',
      expectedBranch: 'main',
    });
    ctx.resolveProfile = undefined as unknown as PhaseHandlerContext['resolveProfile'];

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('command_failed');
    }
  });

  it('returns failed when resolveProfile returns empty', async () => {
    setupCtx({
      promptsRoot: '/p',
      startCommitSha: 'abc',
      expectedBranch: 'main',
      resolveProfile: () => '',
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('command_failed');
    }
  });

  it('returns failed when loadPromptTemplate throws missing template', async () => {
    setupCtx();
    mockLoadPromptTemplate.mockImplementation(() => {
      throw new TemplateNotFoundError(
        'prompt template not found: /tmp/prompts/plan-design/plan-design.md',
      );
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('missing_artifact');
    }
    expect(eventsOf(ctx, `${String(handler.phase)}.failed`)).toHaveLength(1);
  });

  it('returns failed when loadPromptTemplate throws generic error', async () => {
    setupCtx();
    mockLoadPromptTemplate.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('command_failed');
      expect(result.failure.canRetry).toBe(true);
    }
  });

  it('returns failed when renderPrompt throws TemplateError (missing artifact)', async () => {
    setupCtx();
    mockRenderPrompt.mockRejectedValue(new TemplateError('missing artifact: issue.md', 'issue.md'));

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('missing_artifact');
    }
  });

  it('returns failed when artifact write fails', async () => {
    setupCtx();
    (ctx.artifacts as FakeArtifactStore).shouldThrowOnWrite = true;

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('command_failed');
      expect(result.failure.canRetry).toBe(true);
    }
    expect(eventsOf(ctx, `${String(handler.phase)}.failed`)).toHaveLength(1);
  });

  it('returns failed when agent.invoke() throws', async () => {
    setupCtx();
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Test\n',
    });

    // No agent.enqueue — invoke will throw "No scripted response for profile"
    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('command_failed');
    }
  });

  it('returns failed when agent outcome is failed (non-throwing)', async () => {
    setupCtx();
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Test\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult({ outcome: 'failed', exitCode: 1 }));

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('command_failed');
      expect(result.failure.canRetry).toBe(true);
    }
    expect(eventsOf(ctx, `${String(handler.phase)}.failed`)).toHaveLength(1);
  });

  it('returns failed when agent outcome is timeout', async () => {
    setupCtx();
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Test\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult({ outcome: 'timeout', exitCode: 124 }));

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('timeout');
      expect(result.failure.canRetry).toBe(true);
    }
    expect(eventsOf(ctx, `${String(handler.phase)}.failed`)).toHaveLength(1);
  });

  it('returns blocked when validateAgentContract finds violations', async () => {
    setupCtx();
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Test\n',
    });

    const agent = ctx.agent as FakeAgentPort;
    // Agent succeeds but does NOT produce required artifact — contract violation
    // (design.md for PlanDesignHandler)
    agent.enqueue('opencode-frontier', successResult());

    // Write result.json but NOT the required artifact
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({ result: 'ready', summary: 'ok' }),
    });

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.failure.kind).toBe('agent_contract_violation');
    }
    expect(eventsOf(ctx, `${String(handler.phase)}.blocked`)).toHaveLength(1);
  });

  it('passes without result.json — plan-design/plan-write skip result extraction (legacy bash never writes it)', async () => {
    setupCtx();
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Test\n',
    });

    // Write both design.md and plan.md so either handler's contract passes
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    // result.json is absent — handler must still pass (skipResultExtraction: true)
    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');
    expect(agent.invocations).toHaveLength(1);
    expect(eventsOf(ctx, `${String(handler.phase)}.completed`)).toHaveLength(1);
  });

  it('regression: re-materializes missing worktree artifact and emits recovery event', async () => {
    setupCtx();
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Test\n',
    });

    const artifactName = 'design.md';

    // Seed the durable artifacts
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Content',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan Content',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    // Mock existsSync: return true for everything EXCEPT our artifact
    vi.mocked(existsSync).mockImplementation((path) => {
      if (typeof path === 'string' && path.endsWith(artifactName)) {
        return false;
      }
      return true;
    });

    const writeSpy = vi.spyOn(ctx.artifacts, 'write');

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    // Verify recovery event emitted
    expect(eventsOf(ctx, `${String(handler.phase)}.worktree_artifact_recovered`)).toHaveLength(1);

    // Verify it was re-written to the artifact store (which in production
    // re-materializes the worktree copy)
    expect(writeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: artifactName,
        contents: '# Content',
      }),
    );
  });
});
