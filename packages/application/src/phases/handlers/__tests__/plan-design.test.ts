import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { PlanDesignHandler } from '../plan-design.js';
import { PlanWriteHandler } from '../plan-write.js';
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

    // Seed design.md (the required output artifact)
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'design.md',
      contents: '# Design\n\nSome design content.',
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
// PlanWriteHandler — happy path
// ---------------------------------------------------------------------------

describe('PlanWriteHandler', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx({
      promptsRoot: '/tmp/prompts',
      startCommitSha: 'abc123',
      expectedBranch: 'main',
      resolveProfile: () => 'opencode-frontier',
      idFactory: () => 'inv-002',
    });
    seedGit(ctx);
    mockLoadPromptTemplate.mockReturnValue(
      'Plan write for issue {{var:issue_number}}\n\n{{artifact:design.md}}',
    );
    mockRenderPrompt.mockResolvedValue('Plan write for issue 42\n\n# Design\n\nContent.');
  });

  it('happy path: invokes agent, validates contract, extracts result', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'result.json',
      contents: JSON.stringify({
        result: 'ready',
        tasks: [{ title: 'task 1' }],
      }),
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\nSome plan.',
    });

    const handler = new PlanWriteHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(agent.invocations).toHaveLength(1);
    expect(agent.invocations[0]).toBeDefined();
    expect(agent.invocations[0]!.expectedArtifacts).toContain('plan.md');
    expect(eventsOf(ctx, 'plan-write.started')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.completed')).toHaveLength(1);
  });

  it('valid plan.md with no manifest still passes', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\nSome plan.',
    });

    const handler = new PlanWriteHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(eventsOf(ctx, 'plan-write.completed')).toHaveLength(1);
  });

  it('valid plan.md plus valid task-manifest.json passes and emits one plan-write.completed', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Impl\nDescription\n',
    });

    const manifest = {
      version: 1,
      task_count: 1,
      tasks: [{ n: 1, title: 'Impl' }],
    };
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(manifest),
    });

    const handler = new PlanWriteHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(eventsOf(ctx, 'plan-write.completed')).toHaveLength(1);
  });

  it('malformed manifest fails with invalid_result and does not emit plan-write.completed', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Impl\nDescription\n',
    });

    // Malformed manifest JSON
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'task-manifest.json',
      contents: '{ invalid: json }',
    });

    const handler = new PlanWriteHandler({ maxRepairAttempts: 0 });
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
      expect(result.failure.canRetry).toBe(false);
    }
    expect(eventsOf(ctx, 'plan-write.failed')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.completed')).toHaveLength(0);
  });

  it('manifest/prose mismatch fails with invalid_result', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    // Prose lacks '## Task 1:' heading
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\nSome plan without task heading.',
    });

    const manifest = {
      version: 1,
      task_count: 1,
      tasks: [{ n: 1, title: 'Impl' }],
    };
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'task-manifest.json',
      contents: JSON.stringify(manifest),
    });

    const handler = new PlanWriteHandler({ maxRepairAttempts: 0 });
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
      expect(result.failure.canRetry).toBe(false);
    }
    expect(eventsOf(ctx, 'plan-write.failed')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.completed')).toHaveLength(0);
  });

  it('unexpected manifest read error fails gracefully and does not retry', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Impl\nDescription\n',
    });

    // Mock unexpected error during read
    const originalRead = ctx.artifacts.read;
    ctx.artifacts.read = async (runUuid: string, relativePath: string) => {
      if (relativePath === 'task-manifest.json') {
        throw new Error('Permission denied');
      }
      return originalRead.call(ctx.artifacts, runUuid, relativePath);
    };

    const handler = new PlanWriteHandler();
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('unknown');
      expect(result.failure.canRetry).toBe(false);
      expect(result.failure.message).toContain('Permission denied');
    }
    expect(eventsOf(ctx, 'plan-write.failed')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.completed')).toHaveLength(0);
  });

  it('repair loop success path: second attempt passes validation', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;

    // First invocation (returns malformed manifest)
    agent.enqueue('opencode-frontier', successResult());
    // Second invocation (repair, returns valid manifest and plan)
    agent.enqueue('opencode-frontier', successResult());

    // Before first validation check
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Impl\nDescription\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'task-manifest.json',
      contents: '{ invalid: json }', // Causes validation failure
    });

    const handler = new PlanWriteHandler({ maxRepairAttempts: 2 });

    // Hook artifacts.read to return valid content on the second attempt
    const originalRead = ctx.artifacts.read;
    let readCount = 0;
    ctx.artifacts.read = async (runUuid: string, relativePath: string) => {
      if (relativePath === 'task-manifest.json') {
        readCount++;
        if (readCount === 2) {
          return JSON.stringify({
            version: 1,
            task_count: 1,
            tasks: [{ n: 1, title: 'Impl' }],
          });
        }
      }
      return originalRead.call(ctx.artifacts, runUuid, relativePath);
    };

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(eventsOf(ctx, 'plan-write.repair.started')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.repair.succeeded')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.completed')).toHaveLength(1);
    expect(agent.invocations).toHaveLength(2);
  });

  it('repair loop failure path: exhausts repair attempts', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;

    // First invocation (fails)
    agent.enqueue('opencode-frontier', successResult());
    // Second invocation (repair 1, still fails)
    agent.enqueue('opencode-frontier', successResult());

    // Both times return invalid
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Impl\nDescription\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'task-manifest.json',
      contents: '{ invalid: json }',
    });

    const handler = new PlanWriteHandler({ maxRepairAttempts: 1 });
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
    }
    expect(eventsOf(ctx, 'plan-write.repair.started')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.repair.failed')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.failed')).toHaveLength(1);
    expect(agent.invocations).toHaveLength(2);
  });

  it('repair loop handles missing task-manifest.json by generating a default manifest', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;

    // First invocation (returns missing manifest)
    agent.enqueue('opencode-frontier', successResult());
    // Second invocation (repair loop)
    agent.enqueue('opencode-frontier', successResult());

    // Before first validation check
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 2: Impl\nDescription\n', // Fails validation (non-sequential)
    });
    // Deliberately DO NOT write task-manifest.json

    const writeSpy = vi.spyOn(ctx.artifacts, 'write');

    const handler = new PlanWriteHandler({ maxRepairAttempts: 2 });

    const originalRead = ctx.artifacts.read;
    let readCount = 0;
    ctx.artifacts.read = async (runUuid: string, relativePath: string) => {
      if (relativePath === 'task-manifest.json') {
        readCount++;
        if (readCount === 2) {
          return JSON.stringify({
            version: 1,
            task_count: 1,
            tasks: [{ n: 1, title: 'Impl' }],
          });
        }
      }
      if (relativePath === 'plan.md' && readCount >= 1) {
        return '# Plan\n\n## Task 1: Impl\nDescription\n';
      }
      return originalRead.call(ctx.artifacts, runUuid, relativePath);
    };

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(eventsOf(ctx, 'plan-write.repair.started')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.repair.succeeded')).toHaveLength(1);
    expect(agent.invocations).toHaveLength(2);

    // Verify that the default task-manifest.json fallback was written
    expect(writeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'task-manifest.json',
        contents: JSON.stringify({ version: 1, task_count: 0, tasks: [] }),
      }),
    );
  });

  it('validation passes on first attempt: no repair invoked, one agent invocation total', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Impl\nDescription\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({ version: 1, task_count: 1, tasks: [{ n: 1, title: 'Impl' }] }),
    });

    const handler = new PlanWriteHandler({ maxRepairAttempts: 2 });
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(agent.invocations).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.repair.started')).toHaveLength(0);
    expect(eventsOf(ctx, 'plan-write.completed')).toHaveLength(1);
  });

  it('validation fails once, repair succeeds: phase passes with 2 agent invocations', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;
    // First invocation (original plan-write) produces a duplicate-title manifest.
    agent.enqueue('opencode-frontier', successResult());
    // Second invocation (repair) overwrites plan.md/task-manifest.json with a valid pair.
    // FakeAgentResponse supports a function-of-request variant (widened in Step 0 below
    // to allow an async function) so the queued response can perform this side effect
    // before the handler re-reads the artifacts.
    agent.enqueue('opencode-frontier', async () => {
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'plan.md',
        contents: '# Plan\n\n## Task 1: Impl A\nDescription\n\n## Task 2: Impl B\nDescription\n',
      });
      await ctx.artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'task-manifest.json',
        contents: JSON.stringify({
          version: 1,
          task_count: 2,
          tasks: [
            { n: 1, title: 'Impl A' },
            { n: 2, title: 'Impl B' },
          ],
        }),
      });
      return successResult();
    });

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Impl A\nDescription\n\n## Task 2: Impl A\nDescription\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'Impl A' },
          { n: 2, title: 'Impl A' },
        ],
      }),
    });

    const handler = new PlanWriteHandler({ maxRepairAttempts: 2 });
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(agent.invocations).toHaveLength(2);
    expect(eventsOf(ctx, 'plan-write.repair.started')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.repair.succeeded')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.repair.failed')).toHaveLength(0);
    expect(eventsOf(ctx, 'plan-write.completed')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.failed')).toHaveLength(0);
  });

  it("all repair attempts fail: hard-fails after cap exhausted (regression: today's behavior at the end of the cap)", async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;
    // 1 original + 2 repair invocations, all "succeed" at the agent level but never
    // fix the duplicate title.
    agent.enqueue('opencode-frontier', successResult());
    agent.enqueue('opencode-frontier', successResult());
    agent.enqueue('opencode-frontier', successResult());

    const duplicateManifest = JSON.stringify({
      version: 1,
      task_count: 2,
      tasks: [
        { n: 1, title: 'Impl A' },
        { n: 2, title: 'Impl A' },
      ],
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Impl A\nDescription\n\n## Task 2: Impl A\nDescription\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'task-manifest.json',
      contents: duplicateManifest,
    });

    const handler = new PlanWriteHandler({ maxRepairAttempts: 2 });
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
      expect(result.failure.canRetry).toBe(false);
    }
    expect(agent.invocations).toHaveLength(3);
    expect(eventsOf(ctx, 'plan-write.repair.started')).toHaveLength(2);
    expect(eventsOf(ctx, 'plan-write.repair.succeeded')).toHaveLength(0);
    expect(eventsOf(ctx, 'plan-write.repair.failed')).toHaveLength(2);
    expect(eventsOf(ctx, 'plan-write.failed')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.completed')).toHaveLength(0);
  });

  it('maxRepairAttempts: 0 reproduces the pre-repair-loop hard-fail with zero repair invocations', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Impl A\nDescription\n\n## Task 2: Impl A\nDescription\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'Impl A' },
          { n: 2, title: 'Impl A' },
        ],
      }),
    });

    const handler = new PlanWriteHandler({ maxRepairAttempts: 0 });
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
      expect(result.failure.canRetry).toBe(false);
    }
    expect(agent.invocations).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.repair.started')).toHaveLength(0);
    expect(eventsOf(ctx, 'plan-write.failed')).toHaveLength(1);
  });

  it('repair agent invocation itself fails: propagates that failure without further repair attempts', async () => {
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n\nContent.',
    });

    const agent = ctx.agent as FakeAgentPort;
    agent.enqueue('opencode-frontier', successResult());
    // Repair invocation itself fails at the agent level (e.g. timeout).
    agent.enqueue('opencode-frontier', successResult({ outcome: 'timeout', exitCode: 124 }));

    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Impl A\nDescription\n\n## Task 2: Impl A\nDescription\n',
    });
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'Impl A' },
          { n: 2, title: 'Impl A' },
        ],
      }),
    });

    const handler = new PlanWriteHandler({ maxRepairAttempts: 2 });
    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('timeout');
      expect(result.failure.canRetry).toBe(true);
    }
    expect(agent.invocations).toHaveLength(2);
    expect(eventsOf(ctx, 'plan-write.repair.started')).toHaveLength(1);
    expect(eventsOf(ctx, 'plan-write.repair.succeeded')).toHaveLength(0);
    expect(eventsOf(ctx, 'plan-write.repair.failed')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Shared helper error paths (tested via both handlers)
// ---------------------------------------------------------------------------

describe.each([
  ['PlanDesignHandler', () => new PlanDesignHandler()],
  ['PlanWriteHandler', () => new PlanWriteHandler()],
])('runSingleShotAgentPhase error paths - %s', (_name, createHandler) => {
  let ctx: ReturnType<typeof makeCtx>;
  let handler: PhaseHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = createHandler();
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
    // (design.md for PlanDesignHandler, plan.md for PlanWriteHandler)
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
});
