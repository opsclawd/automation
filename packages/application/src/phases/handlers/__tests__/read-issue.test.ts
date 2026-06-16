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

    const artifactCreatedEvents = events.filter((e) => e.type === 'artifact.created');
    expect(artifactCreatedEvents).toHaveLength(2);
    expect(artifactCreatedEvents[0].metadata).toEqual({ path: 'issue.md' });
    expect(artifactCreatedEvents[1].metadata).toEqual({ path: 'issue-comments.md' });
    expect(artifactCreatedEvents.every((e) => e.level === 'info')).toBe(true);

    const startedEvents = events.filter((e) => e.type === 'phase.started');
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].level).toBe('info');
    expect(startedEvents[0].phase).toBe('read_issue');

    const completedEvents = events.filter((e) => e.type === 'phase.completed');
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].level).toBe('info');
    expect(completedEvents[0].phase).toBe('read_issue');
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
    const { ctx, events } = makeCtx(github, artifacts);

    const result = await new ReadIssueHandler().run(ctx);

    expect(result.outcome).toBe('blocked');
    expect(result.failure?.kind).toBe('agent_blocked');
    await expect(artifacts.read('uuid-1', 'issue.md')).rejects.toThrow(ArtifactNotFoundError);

    const blockedEvents = events.filter((e) => e.type === 'phase.blocked');
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0].level).toBe('error');
    expect(blockedEvents[0].phase).toBe('read_issue');
  });

  it('handles an issue with empty body', async () => {
    const github = new FakeGitHubPort();
    github.issues.set('acme/widgets/7', {
      number: 7,
      title: 'Empty body',
      body: '',
      labels: [],
    });
    const artifacts = new FakeArtifactStore();
    const { ctx } = makeCtx(github, artifacts);

    const result = await new ReadIssueHandler().run(ctx);

    expect(result.outcome).toBe('passed');
    const issueContents = await artifacts.read('uuid-1', 'issue.md');
    expect(issueContents).toBe('# Empty body\n');
  });

  it('surfaces a github_failed failure when getIssue throws', async () => {
    const github = new FakeGitHubPort(); // no issue seeded → getIssue throws
    const artifacts = new FakeArtifactStore();
    const { ctx, events } = makeCtx(github, artifacts);

    const result = await new ReadIssueHandler().run(ctx);

    expect(result.outcome).toBe('failed');
    expect(result.failure?.kind).toBe('github_failed');

    const failedEvents = events.filter((e) => e.type === 'phase.failed');
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].level).toBe('error');
    expect(failedEvents[0].phase).toBe('read_issue');
    expect(failedEvents[0].message).toContain('Failed to fetch issue');
  });
});
