import { describe, it, expect, vi } from 'vitest';
import {
  CreatePrHandler,
  _truncateBody,
  _removeSection,
  _removeValidationSteps,
} from '../create-pr.js';
import { FakeArtifactStore, FakeGitPort, FakeGitHubPort } from '../../../test-doubles/index.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

/** IMPORTANT: must NOT seed artifacts — absence/fallback tests rely on empty store. */
async function build(ctxOverrides?: Partial<PhaseHandlerContext>) {
  const artifacts = new FakeArtifactStore();
  // Seed validation.result and validation.headsha by default so tests pass Stage 0 gate
  await artifacts.write({
    runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    relativePath: 'validation.result',
    contents: 'passed\n',
  });
  await artifacts.write({
    runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    relativePath: 'validation.headsha',
    contents: 'base-sha\n',
  });

  const github = new FakeGitHubPort();
  github.issues.set('acme/widgets/7', {
    number: 7,
    title: 'Fix the widget bug',
    body: '',
    labels: [],
  });
  const git = new FakeGitPort();
  git.headByCwd.set('/tmp/wt', 'base-sha');
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

const HANDLER = new CreatePrHandler({ headBranch: () => 'feat/issue-7' });

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

  it('fails when validation.headsha is absent', async () => {
    const { ctx, events, git, github } = await build();
    const storeNoHeadSha = new FakeArtifactStore();
    await storeNoHeadSha.write({
      runId: ctx.runUuid,
      relativePath: 'validation.result',
      contents: 'passed\n',
    });
    const ctxNoHeadSha = { ...ctx, artifacts: storeNoHeadSha } as unknown as PhaseHandlerContext;

    const res = await HANDLER.run(ctxNoHeadSha);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('validation_failed');
      expect(res.failure.message).toContain(
        'Validation SHA (missing) does not match current HEAD SHA (base-sha)',
      );
    }

    const blockedEvent = events.find((e) => e.type === 'create_pr.blocked');
    expect(blockedEvent).toBeDefined();
    expect(git.pushes).toHaveLength(0);
    expect(github.createdPrInputs).toHaveLength(0);
  });

  it('fails when validation.headsha does not match current HEAD SHA', async () => {
    const { artifacts, ctx, git, github } = await build();
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'validation.headsha',
      contents: 'old-sha\n',
    });

    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('validation_failed');
      expect(res.failure.message).toContain(
        'Validation SHA (old-sha) does not match current HEAD SHA (base-sha)',
      );
    }

    expect(git.pushes).toHaveLength(0);
    expect(github.createdPrInputs).toHaveLength(0);
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

  it('reuses pr-url.txt only when the referenced pull request is open', async () => {
    const { artifacts, github, ctx, events } = await build();
    const existingUrl = 'https://github.com/acme/widgets/pull/42';
    github.prs.set('acme/widgets/42', {
      number: 42,
      url: existingUrl,
      state: 'open',
      headRefName: 'feat/issue-7',
    });
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

  it('creates a replacement pull request when pr-url.txt references a merged pull request', async () => {
    const { artifacts, github, ctx, events } = await build();
    const existingUrl = 'https://github.com/acme/widgets/pull/42';
    github.prs.set('acme/widgets/42', {
      number: 42,
      url: existingUrl,
      state: 'merged',
      headRefName: 'feat/issue-7',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'pr-url.txt',
      contents: existingUrl + '\n',
    });

    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('passed');

    const reused = events.filter((e) => e.type === 'pr.reused');
    expect(reused).toHaveLength(0);

    expect(github.createdPrInputs).toHaveLength(1);

    const written = (await artifacts.read(ctx.runUuid, 'pr-url.txt')).trim();
    expect(written).toBe(github.createdPrs[0]!.url);
  });

  it('creates a replacement pull request when pr-url.txt references a closed pull request', async () => {
    const { artifacts, github, ctx, events } = await build();
    const existingUrl = 'https://github.com/acme/widgets/pull/42';
    github.prs.set('acme/widgets/42', {
      number: 42,
      url: existingUrl,
      state: 'closed',
      headRefName: 'feat/issue-7',
    });
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'pr-url.txt',
      contents: existingUrl + '\n',
    });

    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('passed');

    const reused = events.filter((e) => e.type === 'pr.reused');
    expect(reused).toHaveLength(0);

    expect(github.createdPrInputs).toHaveLength(1);

    const written = (await artifacts.read(ctx.runUuid, 'pr-url.txt')).trim();
    expect(written).toBe(github.createdPrs[0]!.url);
  });

  it('fails when pr-url.txt is not a parseable pull request URL', async () => {
    const { artifacts, github, git, ctx, events } = await build();
    const invalidUrl = 'https://github.com/acme/widgets/issues/42';
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'pr-url.txt',
      contents: invalidUrl + '\n',
    });

    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('github_failed');
      expect(res.failure.canRetry).toBe(false);
      expect(res.failure.message).toContain(invalidUrl);
    }

    expect(git.pushes).toHaveLength(0);
    expect(github.createdPrInputs).toHaveLength(0);
    expect(github.labelChanges).toHaveLength(0);

    const completed = events.filter((e) => e.type === 'create_pr.completed');
    expect(completed).toHaveLength(0);
  });

  it('fails when the pull request referenced by pr-url.txt cannot be inspected', async () => {
    const { artifacts, github, git, ctx, events } = await build();
    const existingUrl = 'https://github.com/acme/widgets/pull/999';
    await artifacts.write({
      runId: ctx.runUuid,
      relativePath: 'pr-url.txt',
      contents: existingUrl + '\n',
    });

    const res = await HANDLER.run(ctx);
    expect(res.outcome).toBe('failed');
    if (res.outcome === 'failed') {
      expect(res.failure.kind).toBe('github_failed');
      expect(res.failure.canRetry).toBe(true);
      expect(res.failure.message).toContain('no pr acme/widgets#999');
    }

    expect(git.pushes).toHaveLength(0);
    expect(github.createdPrInputs).toHaveLength(0);
    expect(github.labelChanges).toHaveLength(0);

    const completed = events.filter((e) => e.type === 'create_pr.completed');
    expect(completed).toHaveLength(0);
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

  it('calls cleanOrchestratorArtifacts after summary write and before push', async () => {
    const { artifacts, git, github, ctx } = await build();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gitAny = git as any;

    const calls: string[] = [];
    const originalWrite = artifacts.write.bind(artifacts);
    artifacts.write = async (input) => {
      if (input.relativePath === 'pr-summary.md') calls.push('write-summary');
      return originalWrite(input);
    };
    gitAny.cleanOrchestratorArtifacts = vi.fn().mockImplementation(async () => {
      calls.push('cleanup');
    });
    git.push = vi.fn().mockImplementation(async () => {
      calls.push('push');
    });
    github.createPullRequest = vi.fn().mockImplementation(async (input) => {
      calls.push('create-pr');
      github.createdPrInputs.push(input);
      return { number: 123, url: 'https://github.com/acme/widgets/pull/123' };
    });

    const res = await HANDLER.run(ctx);

    expect(res.outcome).toBe('passed');
    expect(gitAny.cleanOrchestratorArtifacts).toHaveBeenCalledWith(
      ctx.cwd,
      ctx.baseBranch ?? 'main',
    );

    expect(calls.indexOf('write-summary')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('cleanup')).toBeGreaterThan(calls.indexOf('write-summary'));
    expect(calls.indexOf('push')).toBeGreaterThan(calls.indexOf('cleanup'));
    expect(calls.indexOf('create-pr')).toBeGreaterThan(calls.indexOf('push'));
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

  describe('branch ancestry gating', () => {
    it('fails before push when the head branch is already contained in the base branch', async () => {
      const { git, github, ctx, events } = await build();
      git.ancestorResults.set('feat/issue-7|main', true);

      const res = await HANDLER.run(ctx);
      expect(res.outcome).toBe('failed');
      if (res.outcome === 'failed') {
        expect(res.failure.kind).toBe('git_failed');
        expect(res.failure.canRetry).toBe(false);
        expect(res.failure.message).toContain('feat/issue-7');
        expect(res.failure.message).toContain('main');
      }

      expect(git.pushes).toHaveLength(0);
      expect(github.createdPrInputs).toHaveLength(0);
      expect(github.labelChanges).toHaveLength(0);

      const failedEvents = events.filter((e) => e.type === 'create_pr.failed');
      expect(failedEvents).toHaveLength(1);
      const completedEvents = events.filter((e) => e.type === 'create_pr.completed');
      expect(completedEvents).toHaveLength(0);
    });

    it('creates a replacement for a merged pull request when the head branch has new commits', async () => {
      const { artifacts, github, git, ctx, events } = await build();
      const existingUrl = 'https://github.com/acme/widgets/pull/42';
      github.prs.set('acme/widgets/42', {
        number: 42,
        url: existingUrl,
        state: 'merged',
        headRefName: 'feat/issue-7',
      });
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'pr-url.txt',
        contents: existingUrl + '\n',
      });
      git.ancestorResults.set('feat/issue-7|main', false);

      const res = await HANDLER.run(ctx);
      expect(res.outcome).toBe('passed');

      const reused = events.filter((e) => e.type === 'pr.reused');
      expect(reused).toHaveLength(0);

      expect(git.pushes).toHaveLength(1);
      expect(github.createdPrInputs).toHaveLength(1);

      const written = (await artifacts.read(ctx.runUuid, 'pr-url.txt')).trim();
      expect(written).toBe(github.createdPrs[0]!.url);
    });

    it('fails when branch ancestry cannot be determined', async () => {
      const { git, github, ctx, events } = await build();
      vi.spyOn(git, 'isAncestor').mockRejectedValue(new Error('git command failed: merge-base'));

      const res = await HANDLER.run(ctx);
      expect(res.outcome).toBe('failed');
      if (res.outcome === 'failed') {
        expect(res.failure.kind).toBe('git_failed');
        expect(res.failure.canRetry).toBe(true);
        expect(res.failure.message).toContain('git command failed: merge-base');
      }

      expect(git.pushes).toHaveLength(0);
      expect(github.createdPrInputs).toHaveLength(0);
      expect(github.labelChanges).toHaveLength(0);

      const failedEvents = events.filter((e) => e.type === 'create_pr.failed');
      expect(failedEvents).toHaveLength(1);
      const completedEvents = events.filter((e) => e.type === 'create_pr.completed');
      expect(completedEvents).toHaveLength(0);
    });
  });

  describe('label transitions and resume safety', () => {
    it('fails when label transition fails while reusing an open pull request', async () => {
      const { artifacts, github, ctx, events } = await build();
      const existingUrl = 'https://github.com/acme/widgets/pull/42';
      github.prs.set('acme/widgets/42', {
        number: 42,
        url: existingUrl,
        state: 'open',
        headRefName: 'feat/issue-7',
      });
      await artifacts.write({
        runId: ctx.runUuid,
        relativePath: 'pr-url.txt',
        contents: existingUrl + '\n',
      });

      github.updateIssueLabels = vi.fn().mockRejectedValue(new Error('label update rate limited'));

      const res = await HANDLER.run(ctx);

      expect(res.outcome).toBe('failed');
      if (res.outcome === 'failed') {
        expect(res.failure.kind).toBe('github_failed');
        expect(res.failure.canRetry).toBe(true);
        expect(res.failure.message).toContain('label update rate limited');
      }

      const labelError = events.find((e) => e.type === 'github.label_update_failed');
      expect(labelError).toBeDefined();
      expect(labelError?.level).toBe('error');

      const completed = events.filter((e) => e.type === 'create_pr.completed');
      expect(completed).toHaveLength(0);

      expect(github.createdPrInputs).toHaveLength(0);
    });

    it('persists a newly created pull request before failing its label transition', async () => {
      const { artifacts, github, ctx, events } = await build();

      const createdPr = {
        number: 1,
        url: 'https://github.com/acme/widgets/pull/1',
        state: 'open' as const,
      };
      github.createPullRequest = vi.fn().mockImplementation(async (input) => {
        github.createdPrInputs.push(input);
        github.createdPrs.push(createdPr);
        return createdPr;
      });

      github.updateIssueLabels = vi.fn().mockRejectedValue(new Error('label update rate limited'));

      const res = await HANDLER.run(ctx);

      expect(res.outcome).toBe('failed');
      if (res.outcome === 'failed') {
        expect(res.failure.kind).toBe('github_failed');
        expect(res.failure.canRetry).toBe(true);
        expect(res.failure.artifacts).toContain('pr-url.txt');
      }

      const written = (await artifacts.read(ctx.runUuid, 'pr-url.txt')).trim();
      expect(written).toBe(createdPr.url);

      const labelError = events.find((e) => e.type === 'github.label_update_failed');
      expect(labelError).toBeDefined();
      expect(labelError?.level).toBe('error');

      const completed = events.filter((e) => e.type === 'create_pr.completed');
      expect(completed).toHaveLength(0);
    });

    it('resumes a created pull request after a label transition failure without creating a duplicate', async () => {
      const { artifacts, github, ctx } = await build();

      const createdPr = {
        number: 1,
        url: 'https://github.com/acme/widgets/pull/1',
        state: 'open' as const,
      };
      github.createPullRequest = vi.fn().mockImplementation(async (input) => {
        github.createdPrInputs.push(input);
        github.createdPrs.push(createdPr);
        return createdPr;
      });

      const originalUpdate = github.updateIssueLabels.bind(github);
      github.updateIssueLabels = vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary label failure'));

      const res1 = await HANDLER.run(ctx);
      expect(res1.outcome).toBe('failed');
      expect(github.createdPrInputs).toHaveLength(1);

      const createdUrl = (await artifacts.read(ctx.runUuid, 'pr-url.txt')).trim();
      expect(createdUrl).toBe(createdPr.url);

      // Seed GitHub PR store so Stage 1 getPr can inspect the existing open PR
      github.prs.set(`acme/widgets/${createdPr.number}`, {
        number: createdPr.number,
        url: createdPr.url,
        state: 'open',
        headRefName: 'feat/issue-7',
      });

      // Restore updateIssueLabels to succeed
      github.updateIssueLabels = vi.fn().mockImplementation(originalUpdate);

      const res2 = await HANDLER.run(ctx);
      expect(res2.outcome).toBe('passed');
      expect(github.createdPrInputs).toHaveLength(1); // No second PR created!
      expect(github.labelChanges).toHaveLength(1);
      expect(github.labelChanges[0]).toMatchObject({
        add: ['ai:pr-ready'],
        remove: ['ai:in-progress'],
      });
    });

    it('passes only after the required label transition succeeds', async () => {
      const { github, ctx, events } = await build();

      const order: string[] = [];
      github.updateIssueLabels = vi.fn().mockImplementation(async (repo, issue, labels) => {
        order.push('updateIssueLabels');
        github.labelChanges.push({ repoFullName: repo, issueNumber: issue, ...labels });
      });

      ctx.events.publish = (_u: string, e: OrchestratorEvent) => {
        events.push(e);
        if (e.type === 'create_pr.completed') {
          order.push('create_pr.completed');
        }
      };

      const res = await HANDLER.run(ctx);
      expect(res.outcome).toBe('passed');
      expect(order).toEqual(['updateIssueLabels', 'create_pr.completed']);
      expect(github.labelChanges[0]).toMatchObject({
        add: ['ai:pr-ready'],
        remove: ['ai:in-progress'],
      });
    });
  });
});

describe('PR body truncation logic (_truncateBody, _removeSection, _removeValidationSteps)', () => {
  describe('_removeSection', () => {
    it('removes section and preserves blank line block spacing between surrounding sections', () => {
      const input = [
        '## Review Findings',
        '- Critical/High: 0',
        '- Medium/Low: 0',
        '',
        '## Autonomous Actions',
        '### Arbiter Rationale (Task 1)',
        'Deviated from plan.',
        '',
        '## Artifacts',
        'Run logs and artifacts: ai/issues/7/',
      ].join('\n');

      const expected = [
        '## Review Findings',
        '- Critical/High: 0',
        '- Medium/Low: 0',
        '',
        '## Artifacts',
        'Run logs and artifacts: ai/issues/7/',
      ].join('\n');

      const output = _removeSection(input, '## Autonomous Actions');
      expect(output).toBe(expected);
      expect(output).not.toContain('0## Artifacts');
    });

    it('correctly handles single-line section content without skipping lines or deleting adjacent sections', () => {
      const input = [
        '## Review Findings',
        '- Critical/High: 0',
        '',
        '## Autonomous Actions',
        'Single rationale line',
        '',
        '## Artifacts',
        'Run logs: ai/issues/7/',
      ].join('\n');

      const output = _removeSection(input, '## Autonomous Actions');
      expect(output).toContain('## Review Findings\n- Critical/High: 0\n\n## Artifacts');
      expect(output).toContain('Run logs: ai/issues/7/');
      expect(output).not.toContain('Single rationale line');
    });

    it('removes a section at the end of body', () => {
      const input = [
        '## Review Findings',
        '- Critical/High: 0',
        '',
        '## Autonomous Actions',
        '### Rationale',
        'Some detail',
      ].join('\n');

      const output = _removeSection(input, '## Autonomous Actions');
      expect(output).toBe('## Review Findings\n- Critical/High: 0');
    });

    it('returns body unchanged if header is not present', () => {
      const input = '## Tasks\n- Task 1\n\n## Changes\n- Change 1';
      expect(_removeSection(input, '## Autonomous Actions')).toBe(input);
    });

    it('handles compactly-spaced markdown without blank lines before next header', () => {
      const input = [
        '## Review Findings',
        '- Critical/High: 0',
        '## Autonomous Actions',
        'Single rationale line',
        '## Artifacts',
        'Run logs: ai/issues/7/',
      ].join('\n');

      const output = _removeSection(input, '## Autonomous Actions');
      expect(output).toBe(
        '## Review Findings\n- Critical/High: 0\n\n## Artifacts\nRun logs: ai/issues/7/',
      );
    });
  });

  describe('_removeValidationSteps', () => {
    it('strips step details while keeping ## Validation status line and preserving block spacing', () => {
      const input = [
        '## Changes',
        '- File modified',
        '',
        '## Validation: passed',
        '- build: passed',
        '- test: passed',
        '',
        '## Review Findings',
        '- Critical/High: 0',
      ].join('\n');

      const expected = [
        '## Changes',
        '- File modified',
        '',
        '## Validation: passed',
        '',
        '## Review Findings',
        '- Critical/High: 0',
      ].join('\n');

      const output = _removeValidationSteps(input);
      expect(output).toBe(expected);
      expect(output).not.toContain('- build: passed');
      expect(output).not.toContain('passed## Review Findings');
    });

    it('handles compactly-spaced markdown without blank lines before next header', () => {
      const input = ['## Validation: PASSED', '- step 1', '## Artifacts', 'Run logs'].join('\n');

      const output = _removeValidationSteps(input);
      expect(output).toBe('## Validation: PASSED\n\n## Artifacts\nRun logs');
    });

    it('returns body unchanged when validation section has no steps', () => {
      const input = [
        '## Changes',
        '- File modified',
        '',
        '## Validation: passed',
        '',
        '## Review Findings',
        '- Critical/High: 0',
      ].join('\n');

      expect(_removeValidationSteps(input)).toBe(input);
    });
  });

  describe('_truncateBody', () => {
    it('removes Autonomous Actions first when exceeding byte limit', () => {
      const body = [
        '# Title',
        '',
        '## Tasks',
        '- Task 1',
        '',
        '## Changes',
        '- Diff stat',
        '',
        '## Validation: passed',
        '- build: passed',
        '',
        '## Review Findings',
        '- Critical/High: 0',
        '',
        '## Autonomous Actions',
        'Long autonomous actions details...',
        '',
        '## Artifacts',
        'Run logs: ai/issues/1/',
      ].join('\n');

      // Set maxBytes small enough to force removal of Autonomous Actions but fit the rest
      const truncated = _truncateBody(body, 320);
      expect(truncated).not.toContain('## Autonomous Actions');
      expect(truncated).toContain('## Review Findings');
      expect(truncated).toContain('## Artifacts');
      expect(truncated).toContain('PR body truncated to fit within GitHub size limits');
    });

    it('progressively strips Review Findings and Validation steps if body remains too large', () => {
      const body = [
        '# Title',
        '',
        '## Tasks',
        '- Task 1',
        '',
        '## Changes',
        '- Diff stat',
        '',
        '## Validation: passed',
        '- build: passed',
        '- test: passed',
        '',
        '## Review Findings',
        '- Critical/High: 1',
        '',
        '## Autonomous Actions',
        'Autonomous rationale',
        '',
        '## Artifacts',
        'Run logs',
      ].join('\n');

      const truncated = _truncateBody(body, 170);
      expect(truncated).not.toContain('## Autonomous Actions');
      expect(truncated).not.toContain('## Review Findings');
      expect(truncated).not.toContain('- build: passed');
      expect(truncated).toContain('## Validation: passed');
      expect(truncated).toContain('PR body truncated');
    });
  });
});
