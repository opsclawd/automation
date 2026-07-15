import { describe, expect, it, vi } from 'vitest';
import { createRun, type Run, PhaseName as makePhaseName, RepositoryId } from '@ai-sdlc/domain';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { FakePhaseRepository } from '../../test-doubles/fake-phase-repository.js';
import { PhaseHandlerRegistry } from '../phase-handler-registry.js';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../../phases/handler.js';
import type { EventBusPort, FailureRepositoryPort, RunRepositoryPort } from '../../ports.js';
import type { PhaseRepositoryPort } from '../../ports/phase-repository-port.js';
import { RunExecutor } from '../run-executor.js';

const PHASES_AFTER_IMPLEMENT = [
  'validate',
  'fix-validate',
  'review-fix',
  'compound',
  'create-pr',
  'post-pr-review',
] as const;

const FIXED_NOW = new Date('2026-06-22T12:00:00.000Z');

function makeRun(overrides?: Partial<Run>): Run {
  return {
    ...createRun({
      uuid: 'run-uuid-1',
      displayId: 'issue-42-20260622-120000',
      repoId: RepositoryId('acme/widgets'),
      issueNumber: 42,
      startedAt: FIXED_NOW,
    }),
    ...overrides,
  };
}

function makePassingHandler(phase: string, runSpy?: ReturnType<typeof vi.fn>): PhaseHandler {
  return {
    phase: makePhaseName(phase),
    run: async (ctx: PhaseHandlerContext): Promise<PhaseResult> => {
      runSpy?.(ctx);
      return { outcome: 'passed' };
    },
  };
}

function makeDeps(overrides?: {
  runRepository?: Partial<RunRepositoryPort>;
  failureRepository?: Partial<FailureRepositoryPort>;
  phaseRepository?: PhaseRepositoryPort;
  events?: Partial<EventBusPort>;
  registry?: PhaseHandlerRegistry;
  contextFactory?: (run: Run) => PhaseHandlerContext;
}) {
  return {
    runRepository: {
      insertIfNoActive: vi.fn(),
      update: vi.fn(),
      findByUuid: vi.fn(),
      findByIssueNumber: vi.fn(),
      findActiveRuns: vi.fn().mockReturnValue([]),
      updateStatusByIssueNumber: vi.fn().mockReturnValue(true),
      updateStatusByUuid: vi.fn().mockReturnValue(true),
      atomicUpdateByUuid: vi.fn().mockReturnValue(true),
      ...overrides?.runRepository,
    },
    failureRepository: {
      insert: vi.fn(),
      findLatestByRun: vi.fn(),
      ...overrides?.failureRepository,
    },
    phaseRepository: overrides?.phaseRepository ?? new FakePhaseRepository(),
    events: {
      subscribe: vi.fn().mockReturnValue(() => {}),
      publish: vi.fn(),
      ...overrides?.events,
    },
    registry: overrides?.registry ?? new PhaseHandlerRegistry(),
    contextFactory:
      overrides?.contextFactory ??
      ((_run: Run) => ({
        runId: 'run-1',
        runUuid: 'run-uuid-1',
        repoFullName: 'acme/widgets',
        issueNumber: 42,
        cwd: '/tmp/worktree',
        artifacts: new FakeArtifactStore(),
        github: {} as never,
        git: {} as never,
        agent: {} as never,
        events: {
          publish: vi.fn(),
          subscribe: vi.fn().mockReturnValue(() => {}),
        },
        now: () => FIXED_NOW,
      })),
    now: () => FIXED_NOW,
  };
}

function registerPassThroughHandlers(
  registry: PhaseHandlerRegistry,
  implementSpy: ReturnType<typeof vi.fn>,
) {
  registry.register({
    phase: makePhaseName('read_issue'),
    run: async () => ({ outcome: 'passed' }),
  });
  registry.register({
    phase: makePhaseName('plan-design'),
    run: async () => ({ outcome: 'passed' }),
  });
  registry.register({
    phase: makePhaseName('plan-write'),
    run: async () => ({ outcome: 'passed' }),
  });
  registry.register({
    phase: makePhaseName('plan-review'),
    run: async () => ({ outcome: 'passed' }),
  });
  registry.register(makePassingHandler('implement', implementSpy));
  for (const phase of PHASES_AFTER_IMPLEMENT) {
    registry.register(makePassingHandler(phase));
  }
}

describe('RunExecutor durable resume', () => {
  it('skips implement on resume when completed outputs exist durably and continues into validate', async () => {
    const artifacts = new FakeArtifactStore();
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review', 'implement'],
    });

    await artifacts.write({
      runId: run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Issue\n',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue-comments.md',
      contents: '[]\n',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'plan-write',
      relativePath: 'plan.md',
      contents: '# Plan\n',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: '# Implementation Log\nImplemented durably.\n',
    });

    const validateRunSpy = vi.fn();
    const implementRunSpy = vi.fn();
    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, implementRunSpy);
    registry.register({
      phase: makePhaseName('validate'),
      run: async (ctx) => {
        validateRunSpy(ctx);
        return { outcome: 'passed' };
      },
    });

    const deps = makeDeps({
      registry,
      contextFactory: (_run) => ({
        runId: run.displayId,
        runUuid: run.uuid,
        repoFullName: 'acme/widgets',
        issueNumber: 42,
        cwd: '/tmp/worktree',
        artifacts: {
          read: artifacts.read.bind(artifacts),
          write: artifacts.write.bind(artifacts),
          list: async () => artifacts.list(run.uuid),
          hydrateWorktree: async () => artifacts.hydrateWorktree(run.uuid),
        },
        github: {} as never,
        git: {} as never,
        agent: {} as never,
        events: {
          publish: vi.fn(),
          subscribe: vi.fn().mockReturnValue(() => {}),
        },
        now: () => FIXED_NOW,
      }),
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(implementRunSpy).not.toHaveBeenCalled();
    expect(validateRunSpy).toHaveBeenCalledTimes(1);
    expect(result.run.status).toBe('passed');
    expect(result.run.completedPhases).toEqual([
      'read_issue',
      'plan-design',
      'plan-write',
      'plan-review',
      'implement',
      'validate',
      'fix-validate',
      'review-fix',
      'compound',
      'create-pr',
      'post-pr-review',
    ]);

    const implementPhase = result.phases.find(
      (phase) => phase.phase === makePhaseName('implement'),
    );
    expect(implementPhase?.status).toBe('passed');
    const validatePhase = result.phases.find((phase) => phase.phase === makePhaseName('validate'));
    expect(validatePhase?.status).toBe('passed');
  });

  it('fails with missing_artifact when implementation-log.md is absent from the durable artifact listing', async () => {
    const artifacts = new FakeArtifactStore();
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review', 'implement'],
    });

    await artifacts.write({
      runId: run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Issue\n',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue-comments.md',
      contents: '[]\n',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'plan-design',
      relativePath: 'design.md',
      contents: '# Design\n',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'plan-write',
      relativePath: 'plan.md',
      contents: '# Plan\n',
    });

    const validateRunSpy = vi.fn();
    const implementRunSpy = vi.fn();
    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, implementRunSpy);
    registry.register({
      phase: makePhaseName('validate'),
      run: async (ctx) => {
        validateRunSpy(ctx);
        return { outcome: 'passed' };
      },
    });

    const deps = makeDeps({
      registry,
      contextFactory: (_run) => ({
        runId: run.displayId,
        runUuid: run.uuid,
        repoFullName: 'acme/widgets',
        issueNumber: 42,
        cwd: '/tmp/worktree',
        artifacts: {
          read: artifacts.read.bind(artifacts),
          write: artifacts.write.bind(artifacts),
          list: async () => artifacts.list(run.uuid),
          hydrateWorktree: async () => artifacts.hydrateWorktree(run.uuid),
        },
        github: {} as never,
        git: {} as never,
        agent: {} as never,
        events: {
          publish: vi.fn(),
          subscribe: vi.fn().mockReturnValue(() => {}),
        },
        now: () => FIXED_NOW,
      }),
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('failed');
    expect(implementRunSpy).not.toHaveBeenCalled();
    expect(validateRunSpy).not.toHaveBeenCalled();

    const failedImplement = result.phases.find(
      (phase) => phase.phase === makePhaseName('implement'),
    );
    expect(failedImplement?.status).toBe('failed');
    expect(failedImplement?.failure?.kind).toBe('missing_artifact');
    expect(failedImplement?.failure?.message).toContain(
      "phase 'implement' completed per DB but its output 'implementation-log.md' is missing from the artifact store",
    );
  });

  it('calls hydrateWorktree at the start of execute', async () => {
    const hydrateSpy = vi.fn();
    const artifacts = {
      hydrateWorktree: hydrateSpy,
      list: vi.fn().mockResolvedValue([]),
    } as unknown as FakeArtifactStore;
    const run = makeRun();
    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, vi.fn());

    const deps = makeDeps({
      registry,
      contextFactory: () =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          artifacts,
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    await executor.execute({
      run,
      skip: [makePhaseName('plan-review'), makePhaseName('compound')],
      presentArtifacts: [],
    });

    expect(hydrateSpy).toHaveBeenCalledWith(run.uuid);
  });

  it('fails before running any phase when durable artifact hydration fails', async () => {
    const hydrateError = new Error('durable store unavailable');
    const artifacts = {
      hydrateWorktree: vi.fn().mockRejectedValue(hydrateError),
      list: vi.fn().mockResolvedValue([]),
    } as unknown as FakeArtifactStore;
    const run = makeRun();
    const handlerSpy = vi.fn();
    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, handlerSpy);
    const publish = vi.fn();
    const deps = makeDeps({
      registry,
      events: { publish },
      contextFactory: () =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          artifacts,
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({ run, skip: [], presentArtifacts: [] });

    expect(result.run.status).toBe('failed');
    expect(result.phases).toEqual([]);
    expect(handlerSpy).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(
      run.uuid,
      expect.objectContaining({
        type: 'run.worktree_hydration_failed',
        level: 'error',
      }),
    );
  });

  it('re-materializes missing worktree artifacts from durable store on resume', async () => {
    const artifacts = new FakeArtifactStore();
    const run = makeRun({
      completedPhases: ['read_issue'],
    });

    const planPath = 'plan.md';
    const planContent = '# Plan\n';

    // 1. Write to durable store (which also mirrors to worktree in FakeArtifactStore by default)
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: '# Issue\n',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'read_issue',
      relativePath: 'issue-comments.md',
      contents: '[]\n',
    });
    // plan.md exists durably
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'plan-write',
      relativePath: planPath,
      contents: planContent,
    });

    // 2. Simulate worktree wipe (e.g. CancelRun)
    artifacts.deleteFromWorktree(run.uuid, planPath);
    expect(artifacts.existsInWorktree(run.uuid, planPath)).toBe(false);

    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, vi.fn());

    const deps = makeDeps({
      registry,
      contextFactory: (_run) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          artifacts,
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    // 3. Resume run
    await executor.execute({
      run,
      skip: [makePhaseName('plan-review'), makePhaseName('compound')],
      presentArtifacts: [],
    });

    // 4. Verify hydration re-materialized the file
    expect(artifacts.existsInWorktree(run.uuid, planPath)).toBe(true);
    expect(await artifacts.read(run.uuid, planPath)).toBe(planContent);
  });
});
