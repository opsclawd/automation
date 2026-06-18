import { describe, it, expect } from 'vitest';
import { CreatePrHandler } from '../create-pr.js';
import {
  FakeArtifactStore,
  FakeAgentPort,
  FakeGitPort,
  FakeGitHubPort,
} from '../../../test-doubles/index.js';
import type { AgentInvocationResult } from '../../../ports/agent-invocation-types.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

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

const TEMPLATE = '# Create PR for issue {{var:issue_number}}\n\n{{artifact:plan.md}}';

function build(ctxOverrides?: Partial<PhaseHandlerContext>) {
  const artifacts = new FakeArtifactStore();
  const github = new FakeGitHubPort();
  const agent = new FakeAgentPort({
    'opencode-frontier': [
      (req) => {
        void artifacts.write({
          runId: req.runId,
          relativePath: 'pr-summary.md',
          contents: '# Fix issue #7\n\nThis PR resolves the problem.',
        });
        return successResult();
      },
    ],
  });
  const git = new FakeGitPort();
  git.currentBranchByCwd.set('/tmp/wt', 'feat/issue-7');
  const events: OrchestratorEvent[] = [];
  const ctx = {
    runId: 'run-1',
    runUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    repoFullName: 'acme/widgets',
    issueNumber: 7,
    cwd: '/tmp/wt',
    artifacts,
    github,
    git,
    agent,
    events: {
      publish: (_u: string, e: OrchestratorEvent) => events.push(e),
      subscribe: () => () => {},
    },
    now: () => new Date('2026-06-16T00:00:00Z'),
    promptsRoot: '/tmp/prompts',
    startCommitSha: 'abc123',
    expectedBranch: 'feat/issue-7',
    resolveProfile: () => 'opencode-frontier',
    idFactory: () => 'inv-1',
    ...ctxOverrides,
  } as unknown as PhaseHandlerContext;
  return { artifacts, github, agent, git, events, ctx };
}

describe('CreatePrHandler', () => {
  it('drafts summary, opens PR, writes pr-url.txt, flips labels', async () => {
    const { artifacts, github, git, ctx, events } = build();

    // Seed required input artifact (plan.md)
    await artifacts.write({ runId: ctx.runUuid, relativePath: 'plan.md', contents: '# Plan' });

    const res = await new CreatePrHandler({
      baseBranch: 'main',
      headBranch: 'feat/issue-7',
      template: TEMPLATE,
    }).run(ctx);

    expect(res.outcome).toBe('passed');

    // Branch was pushed before PR creation
    expect(git.pushes).toHaveLength(1);
    expect(git.pushes[0]).toMatchObject({ cwd: '/tmp/wt', branch: 'feat/issue-7' });

    // PR was created
    expect(github.createdPrInputs).toHaveLength(1);
    expect(github.createdPrInputs[0]!.headBranch).toBe('feat/issue-7');
    expect(github.createdPrInputs[0]!.baseBranch).toBe('main');
    expect(github.createdPrInputs[0]!.title).toBe('Fix issue #7');

    // pr-url.txt written
    expect(await artifacts.read(ctx.runUuid, 'pr-url.txt')).toContain('https://example/pr/');

    // Labels flipped
    expect(github.labelChanges).toHaveLength(1);
    expect(github.labelChanges[0]).toMatchObject({
      repoFullName: 'acme/widgets',
      issueNumber: 7,
      add: ['ai:pr-ready'],
      remove: ['ai:in-progress'],
    });

    // Events emitted
    const created = events.filter((e) => e.type === 'pr.created');
    expect(created).toHaveLength(1);
    expect(created[0]!.level).toBe('info');

    // runSingleShotAgentPhase emits its own phase.completed, then the handler
    // emits another after GitHub operations complete — both are valid.
    const completed = events.filter((e) => e.type === 'phase.completed');
    expect(completed.length).toBeGreaterThanOrEqual(1);
  });

  it('does not create a second PR when pr-url.txt already exists', async () => {
    const { artifacts, github, ctx, events } = build();

    await artifacts.write({ runId: ctx.runUuid, relativePath: 'plan.md', contents: '# Plan' });
    // Pre-seed pr-url.txt from prior run attempt
    const existingUrl = 'https://example/pr/existing';
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'pr-url.txt',
      contents: existingUrl + '\n',
    });

    const res = await new CreatePrHandler({
      baseBranch: 'main',
      headBranch: 'feat/issue-7',
      template: TEMPLATE,
    }).run(ctx);

    expect(res.outcome).toBe('passed');

    // No new PR created
    expect(github.createdPrInputs).toHaveLength(0);

    // Existing URL preserved
    const written = (await artifacts.read(ctx.runUuid, 'pr-url.txt')).trim();
    expect(written).toBe(existingUrl);

    // Reuse event emitted
    const reused = events.filter((e) => e.type === 'pr.reused');
    expect(reused).toHaveLength(1);
    expect(reused[0]!.level).toBe('info');
    expect(reused[0]!.metadata).toMatchObject({ url: existingUrl });

    // Labels still flipped
    expect(github.labelChanges).toHaveLength(1);
    expect(github.labelChanges[0]).toMatchObject({
      add: ['ai:pr-ready'],
      remove: ['ai:in-progress'],
    });
  });

  it('returns agent_contract_violation when pr-summary.md is missing', async () => {
    const artifacts = new FakeArtifactStore();
    const git = new FakeGitPort();
    git.currentBranchByCwd.set('/tmp/wt', 'feat/issue-7');
    const github = new FakeGitHubPort();
    const agent = new FakeAgentPort({
      'opencode-frontier': [
        () => {
          // Agent writes nothing — contract violation for missing pr-summary.md
          return successResult();
        },
      ],
    });
    const events: OrchestratorEvent[] = [];
    const ctx = {
      runId: 'run-1',
      runUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      repoFullName: 'acme/widgets',
      issueNumber: 7,
      cwd: '/tmp/wt',
      artifacts,
      github,
      git,
      agent,
      events: {
        publish: (_u: string, e: OrchestratorEvent) => events.push(e),
        subscribe: () => () => {},
      },
      now: () => new Date('2026-06-16T00:00:00Z'),
      promptsRoot: '/tmp/prompts',
      startCommitSha: 'abc123',
      expectedBranch: 'feat/issue-7',
      resolveProfile: () => 'opencode-frontier',
      idFactory: () => 'inv-1',
    } as unknown as PhaseHandlerContext;

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan',
    });

    const res = await new CreatePrHandler({
      baseBranch: 'main',
      headBranch: 'feat/issue-7',
      template: TEMPLATE,
    }).run(ctx);

    // runSingleShotAgentPhase catches the missing artifact as 'blocked' with 'agent_contract_violation'
    expect(res.outcome).toBe('blocked');
    if (res.outcome === 'blocked') {
      expect(res.failure.kind).toBe('agent_contract_violation');
    }

    // No PR was created
    expect(github.createdPrInputs).toHaveLength(0);

    // No pr-url.txt written
    await expect(artifacts.read(ctx.runUuid, 'pr-url.txt')).rejects.toThrow();
  });

  it('returns github_failed when createPullRequest throws', async () => {
    const artifacts = new FakeArtifactStore();
    const github = new FakeGitHubPort();

    // Override createPullRequest to throw
    github.createPullRequest = () => Promise.reject(new Error('422 Unprocessable Entity'));

    const git = new FakeGitPort();
    git.currentBranchByCwd.set('/tmp/wt', 'feat/issue-7');

    const agent = new FakeAgentPort({
      'opencode-frontier': [
        (req) => {
          void artifacts.write({
            runId: req.runId,
            relativePath: 'pr-summary.md',
            contents: '# Fix issue #7\n\nThis PR resolves the problem.',
          });
          return successResult();
        },
      ],
    });
    const events: OrchestratorEvent[] = [];
    const ctx = {
      runId: 'run-1',
      runUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      repoFullName: 'acme/widgets',
      issueNumber: 7,
      cwd: '/tmp/wt',
      artifacts,
      github,
      git,
      agent,
      events: {
        publish: (_u: string, e: OrchestratorEvent) => events.push(e),
        subscribe: () => () => {},
      },
      now: () => new Date('2026-06-16T00:00:00Z'),
      promptsRoot: '/tmp/prompts',
      startCommitSha: 'abc123',
      expectedBranch: 'feat/issue-7',
      resolveProfile: () => 'opencode-frontier',
      idFactory: () => 'inv-1',
    } as unknown as PhaseHandlerContext;

    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan',
    });

    const res = await new CreatePrHandler({
      baseBranch: 'main',
      headBranch: 'feat/issue-7',
      template: TEMPLATE,
    }).run(ctx);

    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('github_failed');
      expect(res.failure.message).toContain('422 Unprocessable Entity');
      expect(res.failure.canRetry).toBe(true);
    }

    // No pr-url.txt written
    await expect(artifacts.read(ctx.runUuid, 'pr-url.txt')).rejects.toThrow();

    // failed event emitted
    const failedEvents = events.filter((e) => e.type === 'phase.failed');
    expect(failedEvents).toHaveLength(1);
  });
});
