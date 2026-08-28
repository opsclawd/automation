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
});
