import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../implement.js';
import type { StepRunContext, StepRunResult } from '../implement.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeStepRepository } from '../../../test-doubles/fake-step-repository.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import type { PhaseHandlerContext } from '../../handler.js';

function makeCtx(artifacts: FakeArtifactStore, git: FakeGitPort, priorPhaseName?: string) {
  const events: OrchestratorEvent[] = [];
  const now = () => new Date('2026-06-16T00:00:00Z');
  const ctx = {
    runId: 'run-1',
    runUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    repoFullName: 'acme/widgets',
    issueNumber: 42,
    cwd: '/tmp/wt',
    artifacts,
    github: {} as PhaseHandlerContext['github'],
    git,
    agent: {} as PhaseHandlerContext['agent'],
    events: {
      publish: (_u: string, e: OrchestratorEvent) => {
        events.push(e);
      },
      subscribe: () => () => {},
    },
    now,
    idFactory: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    ...(priorPhaseName !== undefined ? { priorPhaseName } : {}),
  } satisfies PhaseHandlerContext;
  return { ctx, events };
}

function planMd(tasks: string[]): string {
  return ['# Plan', '', ...tasks.map((t) => `## ${t}`), '', '## Notes', 'Extra.'].join('\n');
}

describe('ImplementHandler inbound worktree cleanliness check (issue #959)', () => {
  it('fails before setup when the worktree is dirty and names the prior phase', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'head-sha');
    git.statusByCwd.set('/tmp/wt', ' M packages/application/src/test.ts\n?? scratch-probe.ts\n');
    const setup = vi.fn(async () => ({ ok: true }));
    const runStep = vi.fn(
      async (_sctx: StepRunContext): Promise<StepRunResult> => ({ outcome: 'success' }),
    );
    const { ctx, events } = makeCtx(artifacts, git, 'plan-review');

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('phase_boundary_violation');
      expect(result.failure.message).toContain('plan-review');
      expect(result.failure.message).toContain('packages/application/src/test.ts');
      expect(result.failure.message).toContain('scratch-probe.ts');
    }
    expect(setup).not.toHaveBeenCalled();
    expect(runStep).not.toHaveBeenCalled();
    const implementFailed = events.filter(
      (e) => e.type === 'implement.failed' && e.level === 'error',
    );
    expect(implementFailed).toHaveLength(1);
  });

  it('proceeds when the worktree is clean at the inbound boundary', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'head-sha');
    git.statusByCwd.set('/tmp/wt', '');
    const setup = vi.fn(async () => ({ ok: true }));
    const runStep = vi.fn(
      async (_sctx: StepRunContext): Promise<StepRunResult> => ({ outcome: 'success' }),
    );
    const { ctx } = makeCtx(artifacts, git, 'plan-review');

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(setup).toHaveBeenCalled();
    expect(runStep).toHaveBeenCalled();
  });
});
