import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CreatePrHandler } from '../create-pr.js';
import { FakeArtifactStore, FakeGitPort, FakeGitHubPort } from '../../../test-doubles/index.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

describe('CreatePrHandler clean-worktree gate', () => {
  let artifacts: FakeArtifactStore;
  let github: FakeGitHubPort;
  let git: FakeGitPort;
  let events: OrchestratorEvent[];
  let ctx: PhaseHandlerContext;
  let handler: CreatePrHandler;

  beforeEach(async () => {
    artifacts = new FakeArtifactStore();
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

    github = new FakeGitHubPort();
    github.issues.set('acme/widgets/7', {
      number: 7,
      title: 'Fix the widget bug',
      body: '',
      labels: [],
    });

    git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'base-sha');

    events = [];
    ctx = {
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
    } as unknown as PhaseHandlerContext;

    handler = new CreatePrHandler({ headBranch: () => 'feat/issue-7' });
  });

  it('blocks a passed run with uncommitted source before push or GitHub calls', async () => {
    git.statusByCwd.set('/tmp/wt', ' M packages/application/src/uncommitted.ts\n');

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('git_failed');
      expect(result.failure.message).toContain('packages/application/src/uncommitted.ts');
    }
    expect(git.pushes).toEqual([]);
    expect(github.createdPrInputs).toEqual([]);
    expect(github.labelChanges).toEqual([]);
    expect(events.some((event) => event.type === 'create_pr.blocked')).toBe(true);
  });

  it('does not treat orchestrator artifacts as source changes', async () => {
    git.statusByCwd.set('/tmp/wt', '?? pr-summary.md\n M plan.md\n');

    await expect(handler.run(ctx)).resolves.toMatchObject({ outcome: 'passed' });
    expect(git.pushes).toHaveLength(1);
    expect(github.createdPrInputs).toHaveLength(1);
  });

  it('fails closed before remote effects when git status throws', async () => {
    vi.spyOn(git, 'status').mockRejectedValue(new Error('status unavailable'));

    const result = await handler.run(ctx);

    expect(result).toMatchObject({ outcome: 'failed', failure: { kind: 'git_failed' } });
    expect(git.pushes).toEqual([]);
    expect(github.createdPrInputs).toEqual([]);
    expect(github.labelChanges).toEqual([]);
  });

  it('truncates uncommitted source paths when more than 10 dirty files exist', async () => {
    const files = Array.from(
      { length: 15 },
      (_, i) => `packages/pkg/src/file-${String(i + 1).padStart(2, '0')}.ts`,
    );
    const statusOutput = files.map((f) => `?? ${f}\n`).join('');
    git.statusByCwd.set('/tmp/wt', statusOutput);

    const result = await handler.run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('git_failed');
      expect(result.failure.message).toContain('packages/pkg/src/file-01.ts');
      expect(result.failure.message).toContain('packages/pkg/src/file-10.ts');
      expect(result.failure.message).toContain('and 5 more');
      expect(result.failure.message).not.toContain('packages/pkg/src/file-11.ts');
    }
    const blockedEvent = events.find((e) => e.type === 'create_pr.blocked');
    expect(blockedEvent).toBeDefined();
    expect((blockedEvent?.metadata as { paths?: string[] })?.paths).toHaveLength(15);
  });
});
