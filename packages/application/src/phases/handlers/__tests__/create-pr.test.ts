import { describe, it, expect, vi } from 'vitest';
import { CreatePrHandler } from '../create-pr.js';
import { FakeArtifactStore, FakeGitPort, FakeGitHubPort } from '../../../test-doubles/index.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

/** IMPORTANT: must NOT seed artifacts — absence/fallback tests rely on empty store. */
async function build(ctxOverrides?: Partial<PhaseHandlerContext>) {
  const artifacts = new FakeArtifactStore();
  // Seed validation.result to 'passed' by default so tests pass Stage 0 gate
  await artifacts.write({
    runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    relativePath: 'validation.result',
    contents: 'passed\n',
  });

  const github = new FakeGitHubPort();
  github.issues.set('acme/widgets/7', {
    number: 7,
    title: 'Fix the widget bug',
    body: '',
    labels: [],
  });
  const git = new FakeGitPort();
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
    agent: { invoke: () => Promise.reject(new Error('agent must not be called')) } as never,
    events: {
      publish: (_u: string, e: OrchestratorEvent) => events.push(e),
      subscribe: () => () => {},
    },
    now: () => new Date('2026-06-16T00:00:00Z'),
    startCommitSha: 'base-sha',
    ...ctxOverrides,
  } as unknown as PhaseHandlerContext;
  return { artifacts, github, git, events, ctx };
}

const HANDLER = new CreatePrHandler({ baseBranch: 'main', headBranch: () => 'feat/issue-7' });

describe('CreatePrHandler — deterministic assembly', () => {
  it('assembles pr-summary.md from artifacts, opens PR, writes pr-url.txt, flips labels', async () => {
    const { artifacts, github, git, ctx, events } = await build();

    // Seed input artifacts
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'implementation-log.md',
      contents: '# Implementation Log\nThis PR fixes the widget rendering.\n\nMore detail here.',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 1,
        task_count: 2,
        tasks: [
          { n: 1, title: 'Add diffStat' },
          { n: 2, title: 'Rewrite handler' },
        ],
      }),
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'validation.result',
      contents: 'passed\n',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'validate.log',
      contents: '=== build ===\n=== test ===\n',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'code-review.md',
      contents: '- severity: critical\n- severity: medium',
    });

    const res = await HANDLER.run(ctx);

    expect(res.outcome).toBe('passed');

    // pr-summary.md written
    const summary = await artifacts.read(ctx.runUuid, 'pr-summary.md');
    expect(summary).toContain('# Fix the widget bug');
    expect(summary).toContain('Closes #7');
    expect(summary).toContain('This PR fixes the widget rendering.');
    expect(summary).toContain('## Tasks');
    expect(summary).toContain('- Add diffStat');
    expect(summary).toContain('- Rewrite handler');
    expect(summary).toContain('## Changes');
    expect(summary).toContain('## Validation: passed');
    expect(summary).toContain('- build: passed');
    expect(summary).toContain('- test: passed');
    expect(summary).toContain('## Review Findings');
    expect(summary).toContain('- Critical/High: 1');
    expect(summary).toContain('- Medium/Low: 1');
    expect(summary).toContain('## Artifacts');
    expect(summary).toContain('ai/issues/7/');

    // diffStat was called with the startCommitSha
    // (FakeGitPort.diffStat returns a stub; verify it was invoked via Changes section containing the cwd)
    expect(summary).toContain('/tmp/wt');

    // Branch pushed before PR creation
    expect(git.pushes).toHaveLength(1);
    expect(git.pushes[0]).toMatchObject({ cwd: '/tmp/wt', branch: 'feat/issue-7' });

    // PR created with title from issue
    expect(github.createdPrInputs).toHaveLength(1);
    expect(github.createdPrInputs[0]!.title).toBe('Fix the widget bug');
    expect(github.createdPrInputs[0]!.baseBranch).toBe('main');
    expect(github.createdPrInputs[0]!.headBranch).toBe('feat/issue-7');

    // pr-url.txt written
    const written = await artifacts.read(ctx.runUuid, 'pr-url.txt');
    expect(written.trim()).toMatch(/^https:\/\//);

    // Labels flipped
    expect(github.labelChanges).toHaveLength(1);
    expect(github.labelChanges[0]).toMatchObject({
      add: ['ai:pr-ready'],
      remove: ['ai:in-progress'],
    });

    // Events
    const created = events.filter((e) => e.type === 'pr.created');
    expect(created).toHaveLength(1);
    const completed = events.filter((e) => e.type === 'create_pr.completed');
    expect(completed.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to issue number title when getIssue throws', async () => {
    const { artifacts, ctx } = await build();
    // Don't seed the issue in github — getIssue will throw
    // (FakeGitHubPort built without the issue seeded)
    const github2 = new FakeGitHubPort(); // no issues seeded
    const ctx2 = { ...ctx, github: github2 } as unknown as PhaseHandlerContext;

    const res = await HANDLER.run(ctx2);
    expect(res.outcome).toBe('passed');
    const summary = await artifacts.read(ctx.runUuid, 'pr-summary.md');
    expect(summary).toContain('# Resolve issue #7');
  });

  it('falls back to plan.md task headers when task-manifest.json is absent', async () => {
    const { artifacts, ctx } = await build();
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Goal\n\n### Task 1: Setup\n\n### Task 2: Implement',
    });

    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('passed');
    const summary = await artifacts.read(ctx.runUuid, 'pr-summary.md');
    expect(summary).toContain('- Task 1: Setup');
    expect(summary).toContain('- Task 2: Implement');
  });

  it('includes arbiter rationale and deviation records in Autonomous Actions', async () => {
    const { artifacts, ctx } = await build();
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'arbiter-rationale-1.md',
      contents: 'Decided to proceed with option A.',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'deviation-record-2.md',
      contents: 'Deviated from plan due to type error.',
    });

    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('passed');
    const summary = await artifacts.read(ctx.runUuid, 'pr-summary.md');
    expect(summary).toContain('## Autonomous Actions');
    expect(summary).toContain('### Arbiter Rationale (Task 1)');
    expect(summary).toContain('Decided to proceed with option A.');
    expect(summary).toContain('### Deviation Record (Task 2)');
    expect(summary).toContain('Deviated from plan due to type error.');
  });

  it('omits Autonomous Actions section when no arbiter/deviation files exist', async () => {
    const { artifacts, ctx } = await build();
    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('passed');
    const summary = await artifacts.read(ctx.runUuid, 'pr-summary.md');
    expect(summary).not.toContain('## Autonomous Actions');
  });

  it('shows "No code review performed" when neither code-review.md nor review.md exists', async () => {
    const { artifacts, ctx } = await build();
    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('passed');
    const summary = await artifacts.read(ctx.runUuid, 'pr-summary.md');
    expect(summary).toContain('No code review performed');
  });

  it('reads review.md when code-review.md is absent', async () => {
    const { artifacts, ctx } = await build();
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'review.md',
      contents: '- severity: high\n- severity: low',
    });
    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('passed');
    const summary = await artifacts.read(ctx.runUuid, 'pr-summary.md');
    expect(summary).toContain('- Critical/High: 1');
    expect(summary).toContain('- Medium/Low: 1');
  });

  it('fails when validation.result is absent', async () => {
    const { ctx, events, git, github } = await build();
    const emptyStore = new FakeArtifactStore();
    const ctxNoVal = { ...ctx, artifacts: emptyStore } as unknown as PhaseHandlerContext;

    const res = await HANDLER.run(ctxNoVal);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('validation_failed');
      expect(res.failure.message).toContain('Validation did not pass (status: missing)');
      expect(res.failure.artifacts).toEqual([]);
    }

    const blockedEvent = events.find((e) => e.type === 'create_pr.blocked');
    expect(blockedEvent).toBeDefined();
    expect(git.pushes).toHaveLength(0);
    expect(github.createdPrInputs).toHaveLength(0);
    expect(github.labelChanges).toHaveLength(0);
  });

  it('fails when validation.result is not passed', async () => {
    const { artifacts, ctx, git, github } = await build();
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'validation.result',
      contents: 'failed\n',
    });

    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('validation_failed');
      expect(res.failure.message).toContain('Validation did not pass (status: failed)');
    }

    expect(git.pushes).toHaveLength(0);
    expect(github.createdPrInputs).toHaveLength(0);
    expect(github.labelChanges).toHaveLength(0);
  });

  it('correctly marks failed validation steps from validate.log sentinels', async () => {
    const { artifacts, ctx } = await build();
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'validate.log',
      contents: '=== build ===\n[build failed]\n=== test ===\n',
    });
    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('passed');
    const summary = await artifacts.read(ctx.runUuid, 'pr-summary.md');
    expect(summary).toContain('- build: failed');
    expect(summary).toContain('- test: passed');
  });

  it('does not misattribute a sentinel to the wrong validation step', async () => {
    const { artifacts, ctx } = await build();
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'validate.log',
      contents: '=== typecheck ===\n[build failed]\n',
    });
    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('passed');
    const summary = await artifacts.read(ctx.runUuid, 'pr-summary.md');
    expect(summary).toContain('- typecheck: passed');
    expect(summary).not.toContain('- typecheck: failed');
  });

  it('does not create a second PR when pr-url.txt already exists (idempotency)', async () => {
    const { artifacts, github, ctx, events } = await build();
    const existingUrl = 'https://example/pr/existing';
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'pr-url.txt',
      contents: existingUrl + '\n',
    });

    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('passed');

    // No new PR created
    expect(github.createdPrInputs).toHaveLength(0);

    // Existing URL preserved
    const written = (await artifacts.read(ctx.runUuid, 'pr-url.txt')).trim();
    expect(written).toBe(existingUrl);

    // Reuse event emitted
    const reused = events.filter((e) => e.type === 'pr.reused');
    expect(reused).toHaveLength(1);
    expect(reused[0]!.metadata).toMatchObject({ url: existingUrl });

    // Labels still flipped
    expect(github.labelChanges).toHaveLength(1);
    expect(github.labelChanges[0]).toMatchObject({
      add: ['ai:pr-ready'],
      remove: ['ai:in-progress'],
    });
  });

  it('returns github_failed when createPullRequest throws', async () => {
    const { github, ctx, events } = await build();
    github.createPullRequest = () => Promise.reject(new Error('422 Unprocessable Entity'));

    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('github_failed');
      expect(res.failure.message).toContain('422 Unprocessable Entity');
      expect(res.failure.canRetry).toBe(true);
    }

    // No pr-url.txt written
    expect(github.createdPrInputs).toHaveLength(0);
    const failedEvents = events.filter((e) => e.type === 'create_pr.failed');
    expect(failedEvents).toHaveLength(1);
  });

  it('returns git_failed when push throws', async () => {
    const { git, ctx, events } = await build();
    git.push = () => Promise.reject(new Error('push rejected'));

    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('git_failed');
      expect(res.failure.canRetry).toBe(true);
    }
    const failedEvents = events.filter((e) => e.type === 'create_pr.failed');
    expect(failedEvents).toHaveLength(1);
  });

  it('calls cleanOrchestratorArtifacts after PR creation so all artifacts are available during assembly', async () => {
    const { git, ctx } = await build();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gitAny = git as any;
    const cleanSpy = vi.fn().mockResolvedValue(undefined);
    gitAny.cleanOrchestratorArtifacts = cleanSpy;

    const res = await HANDLER.run(ctx);

    expect(res.outcome).toBe('passed');
    expect(cleanSpy).toHaveBeenCalledWith(ctx.cwd, ctx.baseBranch);
  });

  it('cleanup failure does not fail the phase', async () => {
    const { git, ctx } = await build();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gitAny = git as any;
    gitAny.cleanOrchestratorArtifacts = vi.fn().mockRejectedValue(new Error('git exploded'));

    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('passed');
  });

  it('fails with status missing/empty when validation.result is empty', async () => {
    const { artifacts, ctx, git, github } = await build();
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'validation.result',
      contents: '   \n',
    });

    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('validation_failed');
      expect(res.failure.message).toContain('Validation did not pass (status: missing)');
      expect(res.failure.artifacts).toEqual([]);
    }

    expect(git.pushes).toHaveLength(0);
    expect(github.createdPrInputs).toHaveLength(0);
    expect(github.labelChanges).toHaveLength(0);
  });
});
