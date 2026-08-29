import { describe, it, expect, vi } from 'vitest';
import { WaitMergeHandler } from '../wait-merge.js';
import type { PhaseHandlerContext } from '../../handler.js';
import { FakeArtifactStore, FakeGitHubPort } from '../../../test-doubles/index.js';
import { PhaseName } from '@ai-sdlc/domain';

describe('WaitMergeHandler', () => {
  const createMockContext = (
    artifacts: FakeArtifactStore,
    github: FakeGitHubPort,
  ): PhaseHandlerContext => {
    return {
      runUuid: 'run-1',
      repoFullName: 'owner/repo',
      executionPolicy: 'standard',
      artifacts,
      github,
      events: { publish: vi.fn() },
      now: () => new Date(),
    } as unknown as PhaseHandlerContext;
  };

  it('passes when PR is merged', async () => {
    const artifacts = new FakeArtifactStore();
    const github = new FakeGitHubPort();

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('create-pr'),
      relativePath: 'pr-url.txt',
      contents: 'https://github.com/owner/repo/pull/42',
    });

    github.prs.set('owner/repo/42', {
      number: 42,
      url: 'https://github.com/owner/repo/pull/42',
      state: 'merged',
      merged: true,
      labels: ['ai:pr-ready'],
      comments: [],
      reviews: [],
    });

    const handler = new WaitMergeHandler();
    const ctx = createMockContext(artifacts, github);

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('passed');
  });

  it('fails when PR is closed without merging', async () => {
    const artifacts = new FakeArtifactStore();
    const github = new FakeGitHubPort();

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('create-pr'),
      relativePath: 'pr-url.txt',
      contents: 'https://github.com/owner/repo/pull/42',
    });

    github.prs.set('owner/repo/42', {
      number: 42,
      url: 'https://github.com/owner/repo/pull/42',
      state: 'closed',
      merged: false,
      labels: [],
      comments: [],
      reviews: [],
    });

    const handler = new WaitMergeHandler();
    const ctx = createMockContext(artifacts, github);

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    expect(result.failure?.message).toContain('closed without being merged');
  });

  it('fails when CI checks fail', async () => {
    const artifacts = new FakeArtifactStore();
    const github = new FakeGitHubPort();

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('create-pr'),
      relativePath: 'pr-url.txt',
      contents: 'https://github.com/owner/repo/pull/42',
    });

    github.mergeReadiness.set('owner/repo/42', {
      prNumber: 42,
      state: 'open',
      isMerged: false,
      ciStatus: 'failed',
      mergeStateStatus: 'blocked',
      details: 'Failed checks: test (build)',
    });

    const handler = new WaitMergeHandler();
    const ctx = createMockContext(artifacts, github);

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('failed');
    expect(result.failure?.message).toContain('CI checks or merge requirements failed');
  });

  it('returns resting when PR is open and CI checks are pending', async () => {
    const artifacts = new FakeArtifactStore();
    const github = new FakeGitHubPort();

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('create-pr'),
      relativePath: 'pr-url.txt',
      contents: 'https://github.com/owner/repo/pull/42',
    });

    github.mergeReadiness.set('owner/repo/42', {
      prNumber: 42,
      state: 'open',
      isMerged: false,
      ciStatus: 'pending',
      mergeStateStatus: 'unknown',
    });

    const handler = new WaitMergeHandler();
    const ctx = createMockContext(artifacts, github);

    const result = await handler.run(ctx);
    expect(result.outcome).toBe('resting');
  });

  it('polls in-process and passes once the PR merges partway through the window', async () => {
    const artifacts = new FakeArtifactStore();
    const github = new FakeGitHubPort();

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('create-pr'),
      relativePath: 'pr-url.txt',
      contents: 'https://github.com/owner/repo/pull/42',
    });

    github.mergeReadiness.set('owner/repo/42', {
      prNumber: 42,
      state: 'open',
      isMerged: false,
      ciStatus: 'pending',
      mergeStateStatus: 'unknown',
    });

    const sleep = vi.fn().mockImplementation(async () => {
      github.mergeReadiness.set('owner/repo/42', {
        prNumber: 42,
        state: 'merged',
        isMerged: true,
        ciStatus: 'passed',
        mergeStateStatus: 'clean',
      });
    });

    const handler = new WaitMergeHandler({ maxPolls: 5, pollIntervalMs: 1000, sleep });
    const ctx = createMockContext(artifacts, github);

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('passed');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('rests only after exhausting the full poll window with no resolution', async () => {
    const artifacts = new FakeArtifactStore();
    const github = new FakeGitHubPort();

    await artifacts.write({
      runId: 'run-1',
      phaseId: PhaseName('create-pr'),
      relativePath: 'pr-url.txt',
      contents: 'https://github.com/owner/repo/pull/42',
    });

    github.mergeReadiness.set('owner/repo/42', {
      prNumber: 42,
      state: 'open',
      isMerged: false,
      ciStatus: 'pending',
      mergeStateStatus: 'unknown',
    });

    const sleep = vi.fn().mockResolvedValue(undefined);
    const handler = new WaitMergeHandler({ maxPolls: 3, pollIntervalMs: 1000, sleep });
    const ctx = createMockContext(artifacts, github);

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('resting');
    // Sleeps between polls, not after the final one.
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
