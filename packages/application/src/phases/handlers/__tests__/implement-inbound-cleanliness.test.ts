import { describe, it, expect, vi } from 'vitest';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { ImplementHandler } from '../implement.js';
import type { StepRunContext, StepRunResult } from '../implement.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeStepRepository } from '../../../test-doubles/fake-step-repository.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type {
  WorktreeLifecyclePort,
  InspectWorktreeLifecycleInput,
  WorktreeLifecyclePlan,
  ExecuteWorktreeLifecyclePlanInput,
  WorktreeLifecycleExecutionResult,
  EventRepositoryPort,
} from '../../../ports.js';

class FakeEventRepository implements EventRepositoryPort {
  events: Array<{
    runUuid: string;
    phase?: string;
    level: string;
    type: string;
    message: string;
    metadata?: Record<string, unknown>;
    timestamp: Date;
  }> = [];
  insertError?: Error;

  insert(event: {
    runUuid: string;
    phase?: string;
    level: string;
    type: string;
    message: string;
    metadata?: Record<string, unknown>;
    timestamp: Date;
  }): number {
    if (this.insertError) {
      throw this.insertError;
    }
    this.events.push(event);
    return this.events.length;
  }

  listByRunSince(): ReturnType<EventRepositoryPort['listByRunSince']> {
    return [];
  }
}

class FakeWorktreeLifecycle implements WorktreeLifecyclePort {
  inspectCalls: InspectWorktreeLifecycleInput[] = [];
  executeCalls: ExecuteWorktreeLifecyclePlanInput[] = [];
  planToReturn?: WorktreeLifecyclePlan;
  onExecute?: (plan: WorktreeLifecyclePlan) => void;

  async inspect(input: InspectWorktreeLifecycleInput): Promise<WorktreeLifecyclePlan> {
    this.inspectCalls.push(input);
    if (this.planToReturn) {
      return this.planToReturn;
    }
    return {
      mode: input.mode,
      cwd: input.cwd,
      fingerprint: 'fp-1',
      discardedPaths: [],
      preservedPaths: [],
      trackedChanges: [],
      untrackedPaths: [],
    };
  }

  async execute(
    input: ExecuteWorktreeLifecyclePlanInput,
  ): Promise<WorktreeLifecycleExecutionResult> {
    this.executeCalls.push(input);
    this.onExecute?.(input.plan);
    return {
      success: true,
      discardedPaths: input.plan.discardedPaths,
      preservedPaths: input.plan.preservedPaths,
    };
  }
}

function makeCtx(
  artifacts: FakeArtifactStore,
  git: FakeGitPort,
  options?: {
    priorPhaseName?: string;
    worktreeLifecycle?: WorktreeLifecyclePort;
    eventRepository?: EventRepositoryPort;
    inboundPreserveAllowance?: string[];
  },
) {
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
    ...(options?.priorPhaseName !== undefined ? { priorPhaseName: options.priorPhaseName } : {}),
    ...(options?.worktreeLifecycle !== undefined
      ? { worktreeLifecycle: options.worktreeLifecycle }
      : {}),
    ...(options?.eventRepository !== undefined ? { eventRepository: options.eventRepository } : {}),
    ...(options?.inboundPreserveAllowance !== undefined
      ? { inboundPreserveAllowance: options.inboundPreserveAllowance }
      : {}),
  } satisfies PhaseHandlerContext;
  return { ctx, events };
}

function planMd(tasks: string[]): string {
  return ['# Plan', '', ...tasks.map((t) => `## ${t}`), '', '## Notes', 'Extra.'].join('\n');
}

describe('ImplementHandler inbound worktree cleanliness check (issue #959 & #977)', () => {
  it('fails before setup when the worktree is dirty from a non-plan-review phase', async () => {
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
    const { ctx, events } = makeCtx(artifacts, git, { priorPhaseName: 'plan-write' });

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('phase_boundary_violation');
      expect(result.failure.message).toContain('plan-write');
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
    const { ctx } = makeCtx(artifacts, git, { priorPhaseName: 'plan-review' });

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(setup).toHaveBeenCalled();
    expect(runStep).toHaveBeenCalled();
  });

  it('cleans audited ambient plan-review residue before inbound cleanliness enforcement', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'head-sha');
    git.statusByCwd.set(
      '/tmp/wt',
      ' M packages/application/src/test.ts\n M packages/domain/src/index.ts\n?? scratch-probe.ts\n?? .gitignore\n?? task-manifest.json\n',
    );

    const eventRepo = new FakeEventRepository();
    const lifecycle = new FakeWorktreeLifecycle();
    const callOrder: string[] = [];

    const originalInsert = eventRepo.insert.bind(eventRepo);
    eventRepo.insert = (event) => {
      callOrder.push('eventRepository.insert');
      return originalInsert(event);
    };

    lifecycle.planToReturn = {
      mode: 'phase_boundary',
      cwd: '/tmp/wt',
      fingerprint: 'fp-1',
      discardedPaths: [
        'packages/application/src/test.ts',
        'packages/domain/src/index.ts',
        'scratch-probe.ts',
      ],
      preservedPaths: ['.gitignore', 'task-manifest.json'],
      trackedChanges: ['packages/application/src/test.ts', 'packages/domain/src/index.ts'],
      untrackedPaths: ['scratch-probe.ts'],
    };

    lifecycle.onExecute = () => {
      callOrder.push('worktreeLifecycle.execute');
      // After execute, status is clean (or only artifacts remain)
      git.statusByCwd.set('/tmp/wt', '?? task-manifest.json\n');
    };

    const setup = vi.fn(async () => ({ ok: true }));
    const runStep = vi.fn(
      async (_sctx: StepRunContext): Promise<StepRunResult> => ({ outcome: 'success' }),
    );
    const { ctx, events } = makeCtx(artifacts, git, {
      priorPhaseName: 'plan-review',
      worktreeLifecycle: lifecycle,
      eventRepository: eventRepo,
    });

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(setup).toHaveBeenCalled();
    expect(runStep).toHaveBeenCalled();

    // Verify eventRepository.insert called before worktreeLifecycle.execute
    expect(callOrder).toEqual(['eventRepository.insert', 'worktreeLifecycle.execute']);

    // Verify audit event details
    expect(eventRepo.events).toHaveLength(1);
    const auditEvent = eventRepo.events[0];
    expect(auditEvent.type).toBe('implement.inbound_worktree_reset');
    expect(auditEvent.metadata).toEqual({
      reason: 'implement_inbound',
      priorPhaseName: 'plan-review',
      discardedPaths: [
        'packages/application/src/test.ts',
        'packages/domain/src/index.ts',
        'scratch-probe.ts',
      ],
      preservedPaths: ['.gitignore', 'task-manifest.json'],
    });

    // Verify emit to eventBus
    const inboundResetEvents = events.filter(
      (e) => e.type === 'implement.inbound_worktree_reset' && e.level === 'info',
    );
    expect(inboundResetEvents).toHaveLength(1);
    expect(inboundResetEvents[0].metadata).toEqual({
      reason: 'implement_inbound',
      priorPhaseName: 'plan-review',
      discardedPaths: [
        'packages/application/src/test.ts',
        'packages/domain/src/index.ts',
        'scratch-probe.ts',
      ],
      preservedPaths: ['.gitignore', 'task-manifest.json'],
    });

    // Verify second status read occurred
    expect(git.statusCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('does not clean residue from a non-plan-review prior phase', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'head-sha');
    git.statusByCwd.set('/tmp/wt', '?? probe.ts\n');

    const eventRepo = new FakeEventRepository();
    const lifecycle = new FakeWorktreeLifecycle();
    lifecycle.planToReturn = {
      mode: 'phase_boundary',
      cwd: '/tmp/wt',
      fingerprint: 'fp-1',
      discardedPaths: ['probe.ts'],
      preservedPaths: [],
      trackedChanges: [],
      untrackedPaths: ['probe.ts'],
    };

    const setup = vi.fn(async () => ({ ok: true }));
    const runStep = vi.fn(
      async (_sctx: StepRunContext): Promise<StepRunResult> => ({ outcome: 'success' }),
    );
    const { ctx } = makeCtx(artifacts, git, {
      priorPhaseName: 'read-issue',
      worktreeLifecycle: lifecycle,
      eventRepository: eventRepo,
    });

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('phase_boundary_violation');
      expect(result.failure.message).toContain('read-issue');
    }
    expect(lifecycle.executeCalls).toHaveLength(0);
    expect(eventRepo.events).toHaveLength(0);
    expect(setup).not.toHaveBeenCalled();
    expect(runStep).not.toHaveBeenCalled();
  });

  it('does not mutate when inbound reset audit insertion fails', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'head-sha');
    git.statusByCwd.set('/tmp/wt', '?? probe.ts\n');

    const eventRepo = new FakeEventRepository();
    eventRepo.insertError = new Error('SQLite disk full');
    const lifecycle = new FakeWorktreeLifecycle();
    lifecycle.planToReturn = {
      mode: 'phase_boundary',
      cwd: '/tmp/wt',
      fingerprint: 'fp-1',
      discardedPaths: ['probe.ts'],
      preservedPaths: [],
      trackedChanges: [],
      untrackedPaths: ['probe.ts'],
    };

    const setup = vi.fn(async () => ({ ok: true }));
    const runStep = vi.fn(
      async (_sctx: StepRunContext): Promise<StepRunResult> => ({ outcome: 'success' }),
    );
    const { ctx } = makeCtx(artifacts, git, {
      priorPhaseName: 'plan-review',
      worktreeLifecycle: lifecycle,
      eventRepository: eventRepo,
    });

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('phase_boundary_violation');
    }
    expect(lifecycle.executeCalls).toHaveLength(0);
    expect(setup).not.toHaveBeenCalled();
    expect(runStep).not.toHaveBeenCalled();
  });

  it('preserves orchestrator artifacts and gitignore during inbound cleanup', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'head-sha');
    git.statusByCwd.set('/tmp/wt', '?? scratch.ts\n?? task-manifest.json\n?? .gitignore\n');

    const eventRepo = new FakeEventRepository();
    const lifecycle = new FakeWorktreeLifecycle();
    lifecycle.planToReturn = {
      mode: 'phase_boundary',
      cwd: '/tmp/wt',
      fingerprint: 'fp-1',
      discardedPaths: ['scratch.ts'],
      preservedPaths: ['.gitignore', 'task-manifest.json'],
      trackedChanges: [],
      untrackedPaths: ['scratch.ts'],
    };
    lifecycle.onExecute = () => {
      git.statusByCwd.set('/tmp/wt', '?? task-manifest.json\n');
    };

    const setup = vi.fn(async () => ({ ok: true }));
    const runStep = vi.fn(
      async (_sctx: StepRunContext): Promise<StepRunResult> => ({ outcome: 'success' }),
    );
    const { ctx } = makeCtx(artifacts, git, {
      priorPhaseName: 'plan-review',
      worktreeLifecycle: lifecycle,
      eventRepository: eventRepo,
    });

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(eventRepo.events).toHaveLength(1);
    expect(eventRepo.events[0].metadata?.preservedPaths).toEqual([
      '.gitignore',
      'task-manifest.json',
    ]);
    expect(eventRepo.events[0].metadata?.discardedPaths).toEqual(['scratch.ts']);
  });

  it('accepts approved preserve allowance subset at inbound cleanliness check', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'head-sha');
    git.statusByCwd.set('/tmp/wt', ' M packages/application/src/feature.ts\n');

    const lifecycle = new FakeWorktreeLifecycle();
    const eventRepo = new FakeEventRepository();
    const setup = vi.fn(async () => ({ ok: true }));
    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      git.statusByCwd.set('/tmp/wt', '');
      return { outcome: 'success' };
    });
    const { ctx } = makeCtx(artifacts, git, {
      priorPhaseName: 'plan-review',
      worktreeLifecycle: lifecycle,
      eventRepository: eventRepo,
      inboundPreserveAllowance: [
        'packages/application/src/feature.ts',
        'packages/domain/src/types.ts',
      ],
    });

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(setup).toHaveBeenCalled();
    expect(runStep).toHaveBeenCalled();
    expect(lifecycle.executeCalls).toHaveLength(0);
    expect(eventRepo.events).toHaveLength(0);
  });

  it('rejects paths introduced after an approved inbound snapshot', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'head-sha');
    git.statusByCwd.set(
      '/tmp/wt',
      ' M packages/application/src/feature.ts\n?? unapproved-drift.ts\n',
    );

    const lifecycle = new FakeWorktreeLifecycle();
    const eventRepo = new FakeEventRepository();
    const setup = vi.fn(async () => ({ ok: true }));
    const runStep = vi.fn(
      async (_sctx: StepRunContext): Promise<StepRunResult> => ({ outcome: 'success' }),
    );
    const { ctx } = makeCtx(artifacts, git, {
      priorPhaseName: 'plan-review',
      worktreeLifecycle: lifecycle,
      eventRepository: eventRepo,
      inboundPreserveAllowance: ['packages/application/src/feature.ts'],
    });

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('phase_boundary_violation');
      expect(result.failure.message).toContain('unapproved-drift.ts');
    }
    expect(setup).not.toHaveBeenCalled();
    expect(runStep).not.toHaveBeenCalled();
    expect(lifecycle.executeCalls).toHaveLength(0);
  });

  it('exempts preserved files like .gitignore identified during inspect when preserveAllowance is undefined', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'head-sha');
    // .gitignore is modified (tracked), uncommittedSourcePaths returns ['.gitignore']
    git.statusByCwd.set('/tmp/wt', ' M .gitignore\n');

    const lifecycle = new FakeWorktreeLifecycle();
    const eventRepo = new FakeEventRepository();
    lifecycle.planToReturn = {
      mode: 'phase_boundary',
      cwd: '/tmp/wt',
      fingerprint: 'fp-1',
      discardedPaths: [],
      preservedPaths: ['.gitignore'],
      trackedChanges: ['.gitignore'],
      untrackedPaths: [],
    };

    const setup = vi.fn(async () => ({ ok: true }));
    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      git.statusByCwd.set('/tmp/wt', '');
      return { outcome: 'success' };
    });
    const { ctx } = makeCtx(artifacts, git, {
      priorPhaseName: 'plan-review',
      worktreeLifecycle: lifecycle,
      eventRepository: eventRepo,
      // inboundPreserveAllowance is undefined
    });

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(setup).toHaveBeenCalled();
    expect(runStep).toHaveBeenCalled();
  });

  it('exempts preserved files like .gitignore when entered from non-plan-review phases without executing reset', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'head-sha');
    git.statusByCwd.set('/tmp/wt', ' M .gitignore\n');

    const lifecycle = new FakeWorktreeLifecycle();
    const eventRepo = new FakeEventRepository();
    lifecycle.planToReturn = {
      mode: 'phase_boundary',
      cwd: '/tmp/wt',
      fingerprint: 'fp-1',
      discardedPaths: [],
      preservedPaths: ['.gitignore'],
      trackedChanges: ['.gitignore'],
      untrackedPaths: [],
    };

    const setup = vi.fn(async () => ({ ok: true }));
    const runStep = vi.fn(async (_sctx: StepRunContext): Promise<StepRunResult> => {
      git.statusByCwd.set('/tmp/wt', '');
      return { outcome: 'success' };
    });
    const { ctx } = makeCtx(artifacts, git, {
      priorPhaseName: 'plan-write',
      worktreeLifecycle: lifecycle,
      eventRepository: eventRepo,
    });

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('passed');
    expect(setup).toHaveBeenCalled();
    expect(runStep).toHaveBeenCalled();
    expect(lifecycle.executeCalls).toHaveLength(0);
    expect(eventRepo.events).toHaveLength(0);
  });

  it('rejects unpermitted dirty paths from non-plan-review phases while exempting preserved files', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      relativePath: 'plan.md',
      contents: planMd(['Task 1: work']),
    });
    const steps = new FakeStepRepository();
    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/wt', 'head-sha');
    git.statusByCwd.set('/tmp/wt', ' M .gitignore\n?? rogue.ts\n');

    const lifecycle = new FakeWorktreeLifecycle();
    const eventRepo = new FakeEventRepository();
    lifecycle.planToReturn = {
      mode: 'phase_boundary',
      cwd: '/tmp/wt',
      fingerprint: 'fp-1',
      discardedPaths: ['rogue.ts'],
      preservedPaths: ['.gitignore'],
      trackedChanges: ['.gitignore'],
      untrackedPaths: ['rogue.ts'],
    };

    const setup = vi.fn(async () => ({ ok: true }));
    const runStep = vi.fn(
      async (_sctx: StepRunContext): Promise<StepRunResult> => ({ outcome: 'success' }),
    );
    const { ctx } = makeCtx(artifacts, git, {
      priorPhaseName: 'plan-write',
      worktreeLifecycle: lifecycle,
      eventRepository: eventRepo,
    });

    const result = await new ImplementHandler({ steps, runStep, setup }).run(ctx);

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('phase_boundary_violation');
      expect(result.failure.message).toContain('plan-write');
      expect(result.failure.message).toContain('rogue.ts');
      expect(result.failure.message).not.toContain('.gitignore');
    }
    expect(setup).not.toHaveBeenCalled();
    expect(runStep).not.toHaveBeenCalled();
    expect(lifecycle.executeCalls).toHaveLength(0);
    expect(eventRepo.events).toHaveLength(0);
  });
});
