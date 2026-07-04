import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../phases/handlers/implement.js';
import type { StepRunContext, StepRunResult } from '../phases/handlers/implement.js';
import { FakeArtifactStore } from '../test-doubles/fake-artifact-store.js';
import { FakeStepRepository } from '../test-doubles/fake-step-repository.js';
import { FakeImplementArtifactGuard } from '../test-doubles/fake-implement-artifact-guard.js';
import type { PhaseHandlerContext } from '../phases/handler.js';

function makeCtx(artifacts: FakeArtifactStore) {
  const events: OrchestratorEvent[] = [];
  const now = () => new Date('2026-07-03T00:00:00Z');
  return {
    ctx: {
      runId: 'run-1',
      runUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      repoFullName: 'acme/widgets',
      issueNumber: 42,
      cwd: '/tmp/wt',
      artifacts,
      github: {} as PhaseHandlerContext['github'],
      git: {} as PhaseHandlerContext['git'],
      agent: {} as PhaseHandlerContext['agent'],
      events: {
        publish: (_u: string, e: OrchestratorEvent) => events.push(e),
        subscribe: () => () => {},
      },
      now,
      idFactory: (() => {
        let n = 0;
        return () => `id-${++n}`;
      })(),
      startCommitSha: 'abc123',
    } satisfies PhaseHandlerContext,
    events,
  };
}

function planMd(tasks: string[]) {
  return ['# Plan', '', ...tasks.map((t) => `## ${t}`)].join('\n');
}

describe('ImplementHandler × ImplementArtifactGuard', () => {
  let artifacts: FakeArtifactStore;
  let steps: FakeStepRepository;
  let guard: FakeImplementArtifactGuard;

  beforeEach(async () => {
    artifacts = new FakeArtifactStore();
    steps = new FakeStepRepository();
    guard = new FakeImplementArtifactGuard();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: re-verify done']),
    });
  });

  it('recovers via guard when runStep returns failed and guard returns synthesized', async () => {
    const { ctx, events } = makeCtx(artifacts);
    const runStep = vi.fn().mockResolvedValue({ outcome: 'failed' });
    guard.nextResult = {
      synthesized: [
        { artifact: 'implementation-log.md', reason: 'no_op_reverification_done_declared' },
      ],
    };

    const resolveInvocation = vi.fn().mockResolvedValue({
      startCommitSha: 'abc123',
      endCommitSha: 'abc123',
      durationMs: 1000,
      outcome: 'contract_violation' as const,
      stdoutTail: 'Status: DONE\n',
      stderrTail: '',
      resultJsonPath: undefined,
      expectedArtifacts: ['implementation-log.md'],
    });

    const result = await new ImplementHandler({
      steps,
      runStep: runStep as unknown as (s: StepRunContext) => Promise<StepRunResult>,
      implementArtifactGuard: guard,
      resolveInvocation,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(guard.calls).toHaveLength(1);
    expect(events.some((e) => e.type === 'step.artifact.synthesized')).toBe(true);
    const step = steps.findByIndex(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' as never,
      'implement' as never,
      1,
    );
    expect(step?.status).toBe('success');
  });

  it('recovers via guard when multiple expected artifacts are missing (e.g., log and result file)', async () => {
    const { ctx, events } = makeCtx(artifacts);
    const runStep = vi.fn().mockResolvedValue({ outcome: 'failed' });
    guard.nextResult = {
      synthesized: [
        { artifact: 'implementation-log.md', reason: 'no_op_reverification_done_declared' },
      ],
    };

    const resolveInvocation = vi.fn().mockResolvedValue({
      startCommitSha: 'abc123',
      endCommitSha: 'abc123',
      durationMs: 1000,
      outcome: 'contract_violation' as const,
      stdoutTail: 'Status: DONE\n',
      stderrTail: '',
      resultJsonPath: undefined,
      expectedArtifacts: ['implementation-log.md', 'implement-task-1.result'],
    });

    const result = await new ImplementHandler({
      steps,
      runStep: runStep as unknown as (s: StepRunContext) => Promise<StepRunResult>,
      implementArtifactGuard: guard,
      resolveInvocation,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(guard.calls).toHaveLength(1);
    expect(events.some((e) => e.type === 'step.artifact.synthesized')).toBe(true);
    const step = steps.findByIndex(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' as never,
      'implement' as never,
      1,
    );
    expect(step?.status).toBe('success');
  });

  it('does NOT recover when guard returns empty synthesized list', async () => {
    const { ctx, events } = makeCtx(artifacts);
    const runStep = vi.fn().mockResolvedValue({ outcome: 'failed' });
    guard.nextResult = { synthesized: [] };

    const resolveInvocation = vi.fn().mockResolvedValue({
      startCommitSha: 'abc123',
      endCommitSha: 'abc123',
      durationMs: 1000,
      outcome: 'contract_violation' as const,
      stdoutTail: '',
      stderrTail: '',
      expectedArtifacts: ['implementation-log.md'],
    });

    const result = await new ImplementHandler({
      steps,
      runStep: runStep as unknown as (s: StepRunContext) => Promise<StepRunResult>,
      implementArtifactGuard: guard,
      resolveInvocation,
    }).run(ctx);

    expect(result.outcome).toBe('failed');
    expect(events.some((e) => e.type === 'step.artifact.not_synthesized')).toBe(true);
  });

  it('does NOT call the guard on a successful step', async () => {
    const { ctx } = makeCtx(artifacts);
    const runStep = vi.fn().mockResolvedValue({ outcome: 'success' });
    const resolveInvocation = vi.fn();

    const result = await new ImplementHandler({
      steps,
      runStep: runStep as unknown as (s: StepRunContext) => Promise<StepRunResult>,
      implementArtifactGuard: guard,
      resolveInvocation,
    }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(guard.calls).toHaveLength(0);
    expect(resolveInvocation).not.toHaveBeenCalled();
  });

  it('does NOT call the guard when resolveInvocation returns undefined', async () => {
    const { ctx } = makeCtx(artifacts);
    const runStep = vi.fn().mockResolvedValue({ outcome: 'failed' });
    const resolveInvocation = vi.fn().mockResolvedValue(undefined);

    const result = await new ImplementHandler({
      steps,
      runStep: runStep as unknown as (s: StepRunContext) => Promise<StepRunResult>,
      implementArtifactGuard: guard,
      resolveInvocation,
    }).run(ctx);

    expect(result.outcome).toBe('failed');
    expect(guard.calls).toHaveLength(0);
  });
});
