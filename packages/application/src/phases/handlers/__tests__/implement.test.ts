import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../implement.js';
import type {
  StepRunContext,
  StepRunResult,
  LintTaskSizeResult,
  OversizedTask,
} from '../implement.js';
import { RunId, PhaseName } from '@ai-sdlc/domain';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeStepRepository } from '../../../test-doubles/fake-step-repository.js';
import type { PhaseHandlerContext } from '../../handler.js';

function makeCtx(artifacts: FakeArtifactStore) {
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
    git: {} as PhaseHandlerContext['git'],
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
  } satisfies PhaseHandlerContext;
  return { ctx, events };
}

function planMd(tasks: string[]): string {
  return ['# Plan', '', ...tasks.map((t) => `## ${t}`), '', '## Notes', 'Extra.'].join('\n');
}

describe('ImplementHandler', () => {
  it('runs N tasks → N steps with success persistence', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: first', 'Task 2: second']),
    });
    const steps = new FakeStepRepository();
    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockResolvedValue({ outcome: 'success' });
    const { ctx, events } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(runStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepIndex: 1, stepTitle: 'Task 1: first', cwd: '/tmp/wt', ctx }),
    );
    expect(runStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepIndex: 2, stepTitle: 'Task 2: second', cwd: '/tmp/wt', ctx }),
    );

    const all = steps.listForRun(RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.status)).toEqual(['success', 'success']);
    expect(all.map((s) => s.index)).toEqual([1, 2]);

    expect(events.filter((e) => e.type === 'step.started')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'implement.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'implement.completed')).toHaveLength(1);
  });

  it('resume skips already-successful steps', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: done', 'Task 2: todo']),
    });
    const steps = new FakeStepRepository();
    steps.upsert({
      id: 'step-seeded-1',
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: done',
      status: 'success',
      startedAt: new Date('2026-06-16T00:00:00Z'),
      completedAt: new Date('2026-06-16T00:00:00Z'),
    });
    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockResolvedValue({ outcome: 'success' });
    const { ctx, events } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(runStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepIndex: 2, stepTitle: 'Task 2: todo' }),
    );

    const all = steps.listForRun(RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    expect(all).toHaveLength(2);
    expect(all[0]!.status).toBe('success'); // untouched
    expect(all[1]!.status).toBe('success'); // newly completed

    expect(events.filter((e) => e.type === 'step.skipped')).toHaveLength(1);
  });

  it('resume from failed step re-runs it', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: retry', 'Task 2: done']),
    });
    const steps = new FakeStepRepository();
    steps.upsert({
      id: 'step-seeded-1',
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: retry',
      status: 'failed',
      startedAt: new Date('2026-06-16T00:00:00Z'),
      completedAt: new Date('2026-06-16T00:00:00Z'),
    });
    steps.upsert({
      id: 'step-seeded-2',
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      phaseId: 'implement',
      index: 2,
      title: 'Task 2: done',
      status: 'success',
      startedAt: new Date('2026-06-16T00:00:00Z'),
      completedAt: new Date('2026-06-16T00:00:00Z'),
    });
    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockResolvedValue({ outcome: 'success' });
    const { ctx, events } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(runStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepIndex: 1, stepTitle: 'Task 1: retry' }),
    );

    const all = steps.listForRun(RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    expect(all).toHaveLength(2);
    expect(all.find((s) => s.index === 1)!.status).toBe('success'); // re-ran → success

    expect(events.filter((e) => e.type === 'step.skipped')).toHaveLength(1); // index 2 skipped
  });

  it('needs_human_review outcome records step status and returns needs_human_review', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: ambiguous']),
    });
    const steps = new FakeStepRepository();
    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockResolvedValue({ outcome: 'needs_human_review' });
    const { ctx, events } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('needs_human_review');
    if (result.outcome === 'needs_human_review') {
      expect(result.failure.kind).toBe('agent_incomplete');
      expect(result.failure.message).toContain('needs human review');
    }

    const step = steps.findByIndex(
      RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
      PhaseName('implement'),
      1,
    );
    expect(step!.status).toBe('needs_human_review');

    expect(events.filter((e) => e.type === 'step.needs_human_review')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'implement.failed')).toHaveLength(0);
    expect(events.filter((e) => e.type === 'implement.needs_human_review')).toHaveLength(1);
  });

  it('step failure fails the phase', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: fails']),
    });
    const steps = new FakeStepRepository();
    const runStep = vi
      .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
      .mockResolvedValue({ outcome: 'failed' });
    const { ctx, events } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('agent_incomplete');
      expect(result.failure.message).toContain('Task 1: fails');
    }

    const step = steps.findByIndex(
      RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
      PhaseName('implement'),
      1,
    );
    expect(step!.status).toBe('failed');

    expect(events.filter((e) => e.type === 'step.failed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'implement.failed')).toHaveLength(1);
  });

  it('empty plan fails fast with invalid_result', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: '# Plan\n\nNo task headings here.\n',
    });
    const steps = new FakeStepRepository();
    const runStep = vi.fn<(sctx: StepRunContext) => Promise<StepRunResult>>();
    const { ctx, events } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_result');
      expect(result.failure.canRetry).toBe(false);
    }

    expect(runStep).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'implement.failed')).toHaveLength(1);
  });

  it('missing plan.md fails with missing_artifact', async () => {
    const artifacts = new FakeArtifactStore(); // no plan.md written
    const steps = new FakeStepRepository();
    const runStep = vi.fn<(sctx: StepRunContext) => Promise<StepRunResult>>();
    const { ctx, events } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('missing_artifact');
    }

    expect(runStep).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'implement.failed')).toHaveLength(1);
  });

  it('calls setup once before any step runs', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const order: string[] = [];
    const setup = vi.fn(async (_cwd: string) => {
      order.push('setup');
      return { ok: true };
    });
    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      order.push('step');
      return { outcome: 'success' };
    });
    const { ctx } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(setup).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledWith(ctx.cwd);
    expect(order).toEqual(['setup', 'step']);
  });

  it('does not call setup when plan.md is missing', async () => {
    const artifacts = new FakeArtifactStore(); // no plan.md
    const steps = new FakeStepRepository();
    const setup = vi.fn(async (_cwd: string) => ({ ok: true }));
    const runStep = vi.fn<(sctx: StepRunContext) => Promise<StepRunResult>>();
    const { ctx } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('failed');
    expect(setup).not.toHaveBeenCalled();
  });

  it('does not call setup when plan.md has no tasks', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: '# Plan\n\nNo task headings here.\n',
    });
    const steps = new FakeStepRepository();
    const setup = vi.fn(async (_cwd: string) => ({ ok: true }));
    const runStep = vi.fn<(sctx: StepRunContext) => Promise<StepRunResult>>();
    const { ctx } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('failed');
    expect(setup).not.toHaveBeenCalled();
  });

  it('calls setup once on resume with remaining steps', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: done', 'Task 2: todo']),
    });
    const steps = new FakeStepRepository();
    steps.upsert({
      id: 'step-seeded-1',
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: done',
      status: 'success',
      startedAt: new Date('2026-06-16T00:00:00Z'),
      completedAt: new Date('2026-06-16T00:00:00Z'),
    });
    const order: string[] = [];
    const setup = vi.fn(async (_cwd: string) => {
      order.push('setup');
      return { ok: true };
    });
    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      order.push('step');
      return { outcome: 'success' };
    });
    const { ctx, events } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(setup).toHaveBeenCalledTimes(1);
    expect(runStep).toHaveBeenCalledTimes(1);
    expect(runStep).toHaveBeenCalledWith(
      expect.objectContaining({ stepIndex: 2, stepTitle: 'Task 2: todo' }),
    );
    expect(order).toEqual(['setup', 'step']);

    const all = steps.listForRun(RunId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    expect(all).toHaveLength(2);
    expect(all[0]!.status).toBe('success');
    expect(all[1]!.status).toBe('success');

    expect(events.filter((e) => e.type === 'step.skipped')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'step.completed')).toHaveLength(1);
  });

  it('does not call setup when all steps are already done', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: done']),
    });
    const steps = new FakeStepRepository();
    steps.upsert({
      id: 'step-seeded-1',
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: done',
      status: 'success',
      startedAt: new Date('2026-06-16T00:00:00Z'),
      completedAt: new Date('2026-06-16T00:00:00Z'),
    });
    const setup = vi.fn(async (_cwd: string) => {
      return { ok: true };
    });
    const runStep = vi.fn<(sctx: StepRunContext) => Promise<StepRunResult>>();
    const { ctx } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(setup).not.toHaveBeenCalled();
    expect(runStep).not.toHaveBeenCalled();
  });

  it('fails the phase on setup failure', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: never runs']),
    });
    const steps = new FakeStepRepository();
    const setup = vi.fn(async (_cwd: string) => {
      return { ok: false, error: 'something went wrong' };
    });
    const runStep = vi.fn<(sctx: StepRunContext) => Promise<StepRunResult>>();
    const { ctx, events } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('setup_failed');
      expect(result.failure.message).toContain('something went wrong');
    }
    expect(setup).toHaveBeenCalledTimes(1);
    expect(runStep).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'implement.failed')).toHaveLength(1);
  });

  it('fails the phase on setup crash', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: never runs']),
    });
    const steps = new FakeStepRepository();
    const setup = vi.fn(async (_cwd: string) => {
      throw new Error('setup explosion');
    });
    const runStep = vi.fn<(sctx: StepRunContext) => Promise<StepRunResult>>();
    const { ctx, events } = makeCtx(artifacts);

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('setup_failed');
      expect(result.failure.message).toContain('setup explosion');
    }
    expect(setup).toHaveBeenCalledTimes(1);
    expect(runStep).not.toHaveBeenCalled();
    expect(events.filter((e) => e.type === 'implement.failed')).toHaveLength(1);
  });

  describe('manifest-aware step derivation', () => {
    it('manifest-backed plan persists steps with manifest titles', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'plan.md',
        contents: planMd(['Task 1: Manifest Title 1', 'Task 2: Manifest Title 2']),
      });
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'task-manifest.json',
        contents: JSON.stringify({
          version: 1,
          task_count: 2,
          tasks: [
            { n: 1, title: 'Manifest Title 1' },
            { n: 2, title: 'Manifest Title 2' },
          ],
        }),
      });
      const steps = new FakeStepRepository();
      const runStep = vi
        .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
        .mockResolvedValue({ outcome: 'success' });
      const { ctx } = makeCtx(artifacts);

      const result = await new ImplementHandler({ steps, runStep }).run(ctx);

      expect(result.outcome).toBe('passed');
      expect(runStep).toHaveBeenCalledTimes(2);
      expect(runStep).toHaveBeenCalledWith(
        expect.objectContaining({ stepIndex: 1, stepTitle: 'Task 1: Manifest Title 1' }),
      );
      expect(runStep).toHaveBeenCalledWith(
        expect.objectContaining({ stepIndex: 2, stepTitle: 'Task 2: Manifest Title 2' }),
      );
    });

    it('manifest-backed missing heading fails with invalid_result and runStep is not called', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'plan.md',
        contents: planMd(['Task 1: Manifest Title 1']),
      });
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'task-manifest.json',
        contents: JSON.stringify({
          version: 1,
          task_count: 2,
          tasks: [
            { n: 1, title: 'Manifest Title 1' },
            { n: 2, title: 'Manifest Title 2' },
          ],
        }),
      });
      const steps = new FakeStepRepository();
      const runStep = vi.fn<(sctx: StepRunContext) => Promise<StepRunResult>>();
      const { ctx } = makeCtx(artifacts);

      const result = await new ImplementHandler({ steps, runStep }).run(ctx);

      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.failure.kind).toBe('invalid_result');
        expect(result.failure.message).toContain('Task 2');
      }
      expect(runStep).not.toHaveBeenCalled();
    });

    it('manifest-backed heading inside a balanced fence fails with invalid_result and runStep is not called', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'plan.md',
        contents: [
          '# Plan',
          '',
          '## Task 1: Manifest Title 1',
          '```',
          '## Task 2: Manifest Title 2',
          '```',
          '## Notes',
        ].join('\n'),
      });
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'task-manifest.json',
        contents: JSON.stringify({
          version: 1,
          task_count: 2,
          tasks: [
            { n: 1, title: 'Manifest Title 1' },
            { n: 2, title: 'Manifest Title 2' },
          ],
        }),
      });
      const steps = new FakeStepRepository();
      const runStep = vi.fn<(sctx: StepRunContext) => Promise<StepRunResult>>();
      const { ctx } = makeCtx(artifacts);

      const result = await new ImplementHandler({ steps, runStep }).run(ctx);

      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.failure.kind).toBe('invalid_result');
        expect(result.failure.message).toContain('Task 2');
      }
      expect(runStep).not.toHaveBeenCalled();
    });

    it('manifest-backed plan with mismatched titles fails validation', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'plan.md',
        contents: planMd(['Task 1: first', 'Task 2: second']),
      });
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'task-manifest.json',
        contents: JSON.stringify({
          version: 1,
          task_count: 2,
          tasks: [
            { n: 1, title: 'Manifest Title 1' },
            { n: 2, title: 'Manifest Title 2' },
          ],
        }),
      });
      const steps = new FakeStepRepository();
      const runStep = vi.fn();
      const { ctx } = makeCtx(artifacts);

      const result = await new ImplementHandler({ steps, runStep }).run(ctx);

      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.failure.kind).toBe('invalid_result');
        expect(result.failure.message).toContain('title mismatch');
      }
      expect(runStep).not.toHaveBeenCalled();
    });

    it('no-manifest plans continue to derive ## Task headings as before', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'plan.md',
        contents: planMd(['Task 1: first', 'Task 2: second']),
      });
      const steps = new FakeStepRepository();
      const runStep = vi
        .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
        .mockResolvedValue({ outcome: 'success' });
      const { ctx } = makeCtx(artifacts);

      const result = await new ImplementHandler({ steps, runStep }).run(ctx);

      expect(result.outcome).toBe('passed');
      expect(runStep).toHaveBeenCalledTimes(2);
      expect(runStep).toHaveBeenCalledWith(
        expect.objectContaining({ stepIndex: 1, stepTitle: 'Task 1: first' }),
      );
    });
  });

  describe('parity[#269]: task size linting', () => {
    const MANIFEST_JSON = JSON.stringify({
      version: 1,
      task_count: 2,
      tasks: [
        { n: 1, title: 'Update big test file', files: ['src/__tests__/big.test.ts'] },
        { n: 2, title: 'Update config', files: ['tsconfig.json'] },
      ],
    });

    it('parity[#269]: emits task_size.oversized event when blockOversizedTasks is false', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'plan.md',
        contents: planMd(['Task 1: Update big test file', 'Task 2: Update config']),
      });
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'task-manifest.json',
        contents: MANIFEST_JSON,
      });
      const steps = new FakeStepRepository();
      const runStep = vi
        .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
        .mockResolvedValue({ outcome: 'success' });
      const oversizedTask: OversizedTask = {
        taskNum: 1,
        taskTitle: 'Update big test file',
        file: 'src/__tests__/big.test.ts',
        lineCount: 600,
        testCaseCount: 15,
      };
      const lintTaskSize = vi
        .fn<(cwd: string, manifest: unknown) => Promise<LintTaskSizeResult>>()
        .mockResolvedValue({ ok: true, oversized: [oversizedTask] });
      const { ctx, events } = makeCtx(artifacts);

      const result = await new ImplementHandler({ steps, runStep, lintTaskSize }).run(ctx);

      expect(result.outcome).toBe('passed');
      const warnEvents = events.filter((e) => e.type === 'task_size.oversized');
      expect(warnEvents).toHaveLength(1);
      expect(warnEvents[0]?.metadata.taskNum).toBe(1);
      expect(warnEvents[0]?.level).toBe('warn');
      expect(lintTaskSize).toHaveBeenCalledTimes(1);
    });

    it('parity[#269]: fails phase with invalid_result when blockOversizedTasks is true', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'plan.md',
        contents: planMd(['Task 1: Update big test file']),
      });
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'task-manifest.json',
        contents: JSON.stringify({
          version: 1,
          task_count: 1,
          tasks: [{ n: 1, title: 'Update big test file', files: ['src/__tests__/big.test.ts'] }],
        }),
      });
      const steps = new FakeStepRepository();
      const runStep = vi.fn<(sctx: StepRunContext) => Promise<StepRunResult>>();
      const oversizedTask: OversizedTask = {
        taskNum: 1,
        taskTitle: 'Update big test file',
        file: 'src/__tests__/big.test.ts',
        lineCount: 600,
        testCaseCount: 15,
      };
      const lintTaskSize = vi
        .fn<(cwd: string, manifest: unknown) => Promise<LintTaskSizeResult>>()
        .mockResolvedValue({ ok: false, oversized: [oversizedTask] });
      const { ctx, events } = makeCtx(artifacts);

      const result = await new ImplementHandler({ steps, runStep, lintTaskSize }).run(ctx);

      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.failure.kind).toBe('invalid_result');
        expect(result.failure.canRetry).toBe(false);
        expect(result.failure.message).toContain('task 1');
      }
      expect(runStep).not.toHaveBeenCalled();
      expect(events.filter((e) => e.type === 'implement.failed')).toHaveLength(1);
    });

    it('parity[#269]: silently passes and emits no events when no test files exceed thresholds', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'plan.md',
        contents: planMd(['Task 1: Update small file']),
      });
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'task-manifest.json',
        contents: JSON.stringify({
          version: 1,
          task_count: 1,
          tasks: [{ n: 1, title: 'Update small file', files: ['src/util.ts'] }],
        }),
      });
      const steps = new FakeStepRepository();
      const runStep = vi
        .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
        .mockResolvedValue({ outcome: 'success' });
      const lintTaskSize = vi
        .fn<(cwd: string, manifest: unknown) => Promise<LintTaskSizeResult>>()
        .mockResolvedValue({ ok: true, oversized: [] });
      const { ctx, events } = makeCtx(artifacts);

      const result = await new ImplementHandler({ steps, runStep, lintTaskSize }).run(ctx);

      expect(result.outcome).toBe('passed');
      expect(events.filter((e) => e.type === 'task_size.oversized')).toHaveLength(0);
    });

    it('parity[#269]: does not call lintTaskSize when no manifest is present', async () => {
      const artifacts = new FakeArtifactStore();
      await artifacts.write({
        runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        relativePath: 'plan.md',
        contents: planMd(['Task 1: Work']),
      });
      // no task-manifest.json written
      const steps = new FakeStepRepository();
      const runStep = vi
        .fn<(sctx: StepRunContext) => Promise<StepRunResult>>()
        .mockResolvedValue({ outcome: 'success' });
      const lintTaskSize = vi.fn<(cwd: string, manifest: unknown) => Promise<LintTaskSizeResult>>();
      const { ctx } = makeCtx(artifacts);

      const result = await new ImplementHandler({ steps, runStep, lintTaskSize }).run(ctx);

      expect(result.outcome).toBe('passed');
      expect(lintTaskSize).not.toHaveBeenCalled();
    });
  });
});
