import { describe, it, expect } from 'vitest';
import { ReadIssueHandler } from '../read-issue.js';
import { FakeGitHubPort } from '../../../test-doubles/fake-github-port.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { ArtifactNotFoundError } from '../../../ports/artifact-store.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

function makeCtx(github: FakeGitHubPort, artifacts: FakeArtifactStore) {
  const events: OrchestratorEvent[] = [];
  const ctx = {
    runId: 'issue-7-run',
    runUuid: 'uuid-1',
    repoFullName: 'acme/widgets',
    issueNumber: 7,
    cwd: '/tmp/wt',
    artifacts,
    github,
    git: {} as PhaseHandlerContext['git'],
    agent: {} as PhaseHandlerContext['agent'],
    events: {
      publish: (_u: string, e: OrchestratorEvent) => {
        events.push(e);
      },
      subscribe: () => () => {},
    },
    now: () => new Date('2026-06-16T00:00:00Z'),
  } satisfies PhaseHandlerContext;
  return { ctx, events };
}

describe('ReadIssueHandler', () => {
  it('writes issue.md and returns passed for a normal issue', async () => {
    const github = new FakeGitHubPort();
    github.issues.set('acme/widgets/7', {
      number: 7,
      title: 'Add a thing',
      body: 'Please add the thing.',
      labels: ['enhancement'],
    });
    const artifacts = new FakeArtifactStore();
    const { ctx, events } = makeCtx(github, artifacts);

    const result = await new ReadIssueHandler().run(ctx);

    expect(result.outcome).toBe('passed');
    const issueContents = await artifacts.read('uuid-1', 'issue.md');
    expect(issueContents).toContain('# Add a thing');
    expect(issueContents).toContain('Please add the thing.');
    expect(await artifacts.read('uuid-1', 'issue-comments.md')).toBe('');
    expect(events.some((e) => e.type === 'artifact.created')).toBe(true);
  });

  it('returns blocked when the issue has the ai:blocked label', async () => {
    const github = new FakeGitHubPort();
    github.issues.set('acme/widgets/7', {
      number: 7,
      title: 'Blocked one',
      body: 'body',
      labels: ['ai:blocked'],
    });
    const artifacts = new FakeArtifactStore();
    const { ctx } = makeCtx(github, artifacts);

    const result = await new ReadIssueHandler().run(ctx);

    expect(result.outcome).toBe('blocked');
    expect(result.failure?.kind).toBe('agent_blocked');
    await expect(artifacts.read('uuid-1', 'issue.md')).rejects.toThrow(ArtifactNotFoundError);
  });

  it('surfaces a github_failed failure when getIssue throws', async () => {
    const github = new FakeGitHubPort(); // no issue seeded → getIssue throws
    const artifacts = new FakeArtifactStore();
    const { ctx } = makeCtx(github, artifacts);

    const result = await new ReadIssueHandler().run(ctx);

    expect(result.outcome).toBe('failed');
    expect(result.failure?.kind).toBe('github_failed');
  });
});
