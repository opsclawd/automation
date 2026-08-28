import { describe, expect, it, vi } from 'vitest';
import { createRun, type Run, PhaseName as makePhaseName, RepositoryId } from '@ai-sdlc/domain';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { FakePhaseRepository } from '../../test-doubles/fake-phase-repository.js';
import { FakeStepRepository } from '../../test-doubles/fake-step-repository.js';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { PhaseHandlerRegistry } from '../phase-handler-registry.js';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../../phases/handler.js';
import type {
  EventBusPort,
  FailureRepositoryPort,
  RunRepositoryPort,
  EventRepositoryPort,
  StepRepositoryPort,
  WorktreeLifecyclePort,
  InspectWorktreeLifecycleInput,
  WorktreeLifecyclePlan,
  ExecuteWorktreeLifecyclePlanInput,
  WorktreeLifecycleExecutionResult,
} from '../../ports.js';
import type { PhaseRepositoryPort } from '../../ports/phase-repository-port.js';
import { RunExecutor } from '../run-executor.js';
import { ImplementHandler } from '../../phases/handlers/implement.js';

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
  executeResult?: WorktreeLifecycleExecutionResult;
  inspectError?: Error;
  executeError?: Error;

  async inspect(input: InspectWorktreeLifecycleInput): Promise<WorktreeLifecyclePlan> {
    this.inspectCalls.push(input);
    if (this.inspectError) {
      throw this.inspectError;
    }
    if (this.planToReturn) {
      return this.planToReturn;
    }
    return {
      mode: input.mode,
      cwd: input.cwd,
      targetBaseline: input.targetBaseline,
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
    if (this.executeError) {
      throw this.executeError;
    }
    this.onExecute?.(input.plan);
    if (this.executeResult) {
      return this.executeResult;
    }
    return {
      success: true,
      discardedPaths: input.plan.discardedPaths,
      preservedPaths: input.plan.preservedPaths,
      headSha: input.plan.targetBaseline,
    };
  }
}

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

async function writeCompletedPhaseArtifacts(artifacts: FakeArtifactStore, runUuid: string) {
  await artifacts.write({
    runId: runUuid,
    phaseId: 'read_issue',
    relativePath: 'issue.md',
    contents: '# Issue\n',
  });
  await artifacts.write({
    runId: runUuid,
    phaseId: 'read_issue',
    relativePath: 'issue-comments.md',
    contents: '[]\n',
  });
  await artifacts.write({
    runId: runUuid,
    phaseId: 'plan-design',
    relativePath: 'design.md',
    contents: '# Design\n',
  });
  await artifacts.write({
    runId: runUuid,
    phaseId: 'plan-write',
    relativePath: 'plan.md',
    contents: '# Plan\n\n## Task 1: Build feature\n',
  });
}

function makeDeps(overrides?: {
  runRepository?: Partial<RunRepositoryPort>;
  failureRepository?: Partial<FailureRepositoryPort>;
  phaseRepository?: PhaseRepositoryPort;
  stepRepository?: StepRepositoryPort;
  eventRepository?: EventRepositoryPort;
  worktreeLifecycle?: WorktreeLifecyclePort;
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
    stepRepository: overrides?.stepRepository,
    eventRepository: overrides?.eventRepository,
    worktreeLifecycle: overrides?.worktreeLifecycle,
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

  it('resets an interrupted implementation step to its original durable baseline before hydration', async () => {
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    const stepRepo = new FakeStepRepository();
    stepRepo.upsert({
      id: 'step-1',
      runId: run.uuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: Build feature',
      status: 'failed',
      initialPreStepHead: 'baseline-sha-1111',
      revertCounts: {},
    });

    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/worktree', 'drifted-sha-2222');
    git.statusByCwd.set('/tmp/worktree', ' M packages/application/src/foo.ts\n?? scratch.ts\n');

    const eventRepo = new FakeEventRepository();
    const lifecycle = new FakeWorktreeLifecycle();
    lifecycle.planToReturn = {
      mode: 'resume_baseline',
      cwd: '/tmp/worktree',
      targetBaseline: 'baseline-sha-1111',
      fingerprint: 'fp-1',
      discardedPaths: ['packages/application/src/foo.ts', 'scratch.ts'],
      preservedPaths: ['.gitignore', 'task-manifest.json'],
      trackedChanges: ['packages/application/src/foo.ts'],
      untrackedPaths: ['scratch.ts'],
    };

    const callOrder: string[] = [];

    const originalInsert = eventRepo.insert.bind(eventRepo);
    eventRepo.insert = (event) => {
      callOrder.push('eventRepository.insert');
      return originalInsert(event);
    };

    lifecycle.onExecute = (plan) => {
      callOrder.push('worktreeLifecycle.execute');
      expect(plan.targetBaseline).toBe('baseline-sha-1111');
    };

    const artifacts = new FakeArtifactStore();
    await writeCompletedPhaseArtifacts(artifacts, run.uuid);
    const originalHydrate = artifacts.hydrateWorktree.bind(artifacts);
    artifacts.hydrateWorktree = async (runUuid) => {
      callOrder.push('artifacts.hydrateWorktree');
      return originalHydrate(runUuid);
    };

    await artifacts.write({
      runId: run.uuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: '# Done',
    });

    const implementSpy = vi.fn(async (_ctx: PhaseHandlerContext) => {
      callOrder.push('implementHandler.run');
      return { outcome: 'passed' as const };
    });

    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, implementSpy);

    const deps = makeDeps({
      registry,
      stepRepository: stepRepo,
      eventRepository: eventRepo,
      worktreeLifecycle: lifecycle,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          repoFullName: 'acme/widgets',
          issueNumber: 42,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'reset_to_baseline',
    });

    expect(result.run.status).toBe('passed');
    expect(callOrder).toEqual([
      'eventRepository.insert',
      'worktreeLifecycle.execute',
      'artifacts.hydrateWorktree',
      'implementHandler.run',
    ]);
    expect(eventRepo.events).toHaveLength(1);
    expect(eventRepo.events[0].type).toBe('run.resume_worktree_reset');
    expect(eventRepo.events[0].metadata?.baseline).toBe('baseline-sha-1111');
    expect(deps.events.publish).toHaveBeenCalledWith(
      run.uuid,
      expect.objectContaining({
        type: 'run.resume_worktree_reset',
        metadata: expect.objectContaining({
          baseline: 'baseline-sha-1111',
          stepIndex: 1,
        }),
      }),
    );
    expect(lifecycle.inspectCalls[0].targetBaseline).toBe('baseline-sha-1111');
  });

  it('escalates missing resume baseline without mutation or dispatch', async () => {
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    const stepRepo = new FakeStepRepository();
    stepRepo.upsert({
      id: 'step-1',
      runId: run.uuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: Build feature',
      status: 'failed',
      // initialPreStepHead is missing
      revertCounts: {},
    });

    const git = new FakeGitPort();
    const eventRepo = new FakeEventRepository();
    const lifecycle = new FakeWorktreeLifecycle();
    const artifacts = new FakeArtifactStore();
    const hydrateSpy = vi.spyOn(artifacts, 'hydrateWorktree');
    const implementSpy = vi.fn();

    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, implementSpy);

    const deps = makeDeps({
      registry,
      stepRepository: stepRepo,
      eventRepository: eventRepo,
      worktreeLifecycle: lifecycle,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'reset_to_baseline',
    });

    expect(result.run.status).toBe('needs_human_review');
    expect(lifecycle.executeCalls).toHaveLength(0);
    expect(hydrateSpy).not.toHaveBeenCalled();
    expect(implementSpy).not.toHaveBeenCalled();
  });

  it('escalates unresolvable resume baseline without falling back to HEAD', async () => {
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    const stepRepo = new FakeStepRepository();
    stepRepo.upsert({
      id: 'step-1',
      runId: run.uuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: Build feature',
      status: 'failed',
      initialPreStepHead: 'unresolvable-bad-sha',
      revertCounts: {},
    });

    const git = new FakeGitPort();
    const eventRepo = new FakeEventRepository();
    const lifecycle = new FakeWorktreeLifecycle();
    lifecycle.inspectError = new Error("targetBaseline 'unresolvable-bad-sha' is unresolvable");

    const artifacts = new FakeArtifactStore();
    const hydrateSpy = vi.spyOn(artifacts, 'hydrateWorktree');
    const implementSpy = vi.fn();

    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, implementSpy);

    const deps = makeDeps({
      registry,
      stepRepository: stepRepo,
      eventRepository: eventRepo,
      worktreeLifecycle: lifecycle,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'reset_to_baseline',
    });

    expect(result.run.status).toBe('needs_human_review');
    expect(lifecycle.executeCalls).toHaveLength(0);
    expect(hydrateSpy).not.toHaveBeenCalled();
    expect(implementSpy).not.toHaveBeenCalled();
  });

  it('does not reset when resume audit insertion fails', async () => {
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    const stepRepo = new FakeStepRepository();
    stepRepo.upsert({
      id: 'step-1',
      runId: run.uuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: Build feature',
      status: 'failed',
      initialPreStepHead: 'baseline-sha-1111',
      revertCounts: {},
    });

    const git = new FakeGitPort();
    const eventRepo = new FakeEventRepository();
    eventRepo.insertError = new Error('SQLite disk full');
    const lifecycle = new FakeWorktreeLifecycle();

    const artifacts = new FakeArtifactStore();
    const hydrateSpy = vi.spyOn(artifacts, 'hydrateWorktree');
    const implementSpy = vi.fn();

    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, implementSpy);

    const deps = makeDeps({
      registry,
      stepRepository: stepRepo,
      eventRepository: eventRepo,
      worktreeLifecycle: lifecycle,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'reset_to_baseline',
    });

    expect(result.run.status).toBe('needs_human_review');
    expect(lifecycle.executeCalls).toHaveLength(0);
    expect(hydrateSpy).not.toHaveBeenCalled();
    expect(implementSpy).not.toHaveBeenCalled();
  });

  it('hydrates artifacts only after successful reset', async () => {
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    const stepRepo = new FakeStepRepository();
    stepRepo.upsert({
      id: 'step-1',
      runId: run.uuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: Build feature',
      status: 'failed',
      initialPreStepHead: 'baseline-sha-1111',
      revertCounts: {},
    });

    const git = new FakeGitPort();
    const eventRepo = new FakeEventRepository();
    const lifecycle = new FakeWorktreeLifecycle();
    lifecycle.executeResult = { success: false, discardedPaths: [], preservedPaths: [] };

    const artifacts = new FakeArtifactStore();
    const hydrateSpy = vi.spyOn(artifacts, 'hydrateWorktree');
    const implementSpy = vi.fn();

    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, implementSpy);

    const deps = makeDeps({
      registry,
      stepRepository: stepRepo,
      eventRepository: eventRepo,
      worktreeLifecycle: lifecycle,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'reset_to_baseline',
    });

    expect(result.run.status).toBe('needs_human_review');
    expect(lifecycle.executeCalls).toHaveLength(1);
    expect(hydrateSpy).not.toHaveBeenCalled();
    expect(implementSpy).not.toHaveBeenCalled();
  });

  it('preserves only current-task writable dirty paths', async () => {
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    const stepRepo = new FakeStepRepository();
    stepRepo.upsert({
      id: 'step-1',
      runId: run.uuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: Build feature',
      status: 'failed',
      initialPreStepHead: 'baseline-sha-1111',
      revertCounts: {},
    });

    const artifacts = new FakeArtifactStore();
    await writeCompletedPhaseArtifacts(artifacts, run.uuid);
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        tasks: [
          {
            n: 1,
            title: 'Task 1',
            expected_files: ['src/task1.ts'],
            reference_files: [],
          },
        ],
      }),
    });
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Build feature\n',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: '# Done',
    });

    const git = new FakeGitPort();
    git.statusByCwd.set('/tmp/worktree', ' M src/task1.ts\n');

    const lifecycle = new FakeWorktreeLifecycle();
    const eventRepo = new FakeEventRepository();

    let capturedApprovedPaths: string[] | undefined;
    const implementSpy = vi.fn(async (ctx: PhaseHandlerContext) => {
      capturedApprovedPaths = ctx.approvedInboundPaths;
      return { outcome: 'passed' as const };
    });

    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, implementSpy);

    const deps = makeDeps({
      registry,
      stepRepository: stepRepo,
      eventRepository: eventRepo,
      worktreeLifecycle: lifecycle,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'preserve_working_tree',
    });

    expect(result.run.status).toBe('passed');
    expect(lifecycle.executeCalls).toHaveLength(0); // Git never mutated
    expect(implementSpy).toHaveBeenCalled();
    expect(capturedApprovedPaths).toEqual(['src/task1.ts']);
  });

  it('rejects undeclared untracked and reference paths without mutation', async () => {
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    const stepRepo = new FakeStepRepository();
    stepRepo.upsert({
      id: 'step-1',
      runId: run.uuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: Build feature',
      status: 'failed',
      initialPreStepHead: 'baseline-sha-1111',
      revertCounts: {},
    });

    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        tasks: [
          {
            n: 1,
            title: 'Task 1',
            expected_files: ['src/task1.ts'],
            reference_files: ['src/ref.ts'],
          },
        ],
      }),
    });

    const git = new FakeGitPort();
    git.statusByCwd.set('/tmp/worktree', ' M src/ref.ts\n?? src/untracked.ts\n');

    const lifecycle = new FakeWorktreeLifecycle();
    const eventRepo = new FakeEventRepository();
    const implementSpy = vi.fn();

    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, implementSpy);

    const deps = makeDeps({
      registry,
      stepRepository: stepRepo,
      eventRepository: eventRepo,
      worktreeLifecycle: lifecycle,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'preserve_working_tree',
    });

    expect(result.run.status).toBe('needs_human_review');
    expect(lifecycle.executeCalls).toHaveLength(0);
    expect(implementSpy).not.toHaveBeenCalled();
  });

  it('rejects a dirty-set change after preserve approval', async () => {
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    const stepRepo = new FakeStepRepository();
    stepRepo.upsert({
      id: 'step-1',
      runId: run.uuid,
      phaseId: 'implement',
      index: 1,
      title: 'Task 1: Build feature',
      status: 'failed',
      initialPreStepHead: 'baseline-sha-1111',
      revertCounts: {},
    });

    const artifacts = new FakeArtifactStore();
    await writeCompletedPhaseArtifacts(artifacts, run.uuid);
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({
        version: 2,
        tasks: [
          {
            n: 1,
            title: 'Task 1',
            expected_files: ['src/task1.ts'],
            reference_files: [],
          },
        ],
      }),
    });
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: Build feature\n',
    });

    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/worktree', 'head-sha');
    // Initially only src/task1.ts is dirty (approved during preserve preparation)
    git.statusByCwd.set('/tmp/worktree', ' M src/task1.ts\n');

    const lifecycle = new FakeWorktreeLifecycle();
    const eventRepo = new FakeEventRepository();

    // Use a real ImplementHandler whose checkInboundWorktreeCleanliness will run
    const realImplementHandler = new ImplementHandler({
      steps: stepRepo,
      runStep: async () => ({ outcome: 'success' }),
    });

    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, vi.fn());
    registry.register({
      phase: makePhaseName('implement'),
      run: async (ctx) => {
        // Between preserve approval and handler cleanliness check, status drifts
        git.statusByCwd.set('/tmp/worktree', ' M src/task1.ts\n?? unapproved.ts\n');
        return realImplementHandler.run(ctx);
      },
    });

    const deps = makeDeps({
      registry,
      stepRepository: stepRepo,
      eventRepository: eventRepo,
      worktreeLifecycle: lifecycle,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          repoFullName: 'acme/widgets',
          issueNumber: 42,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'preserve_working_tree',
    });

    expect(result.run.status).toBe('failed');
    const implementPhase = result.phases.find((p) => p.phase === makePhaseName('implement'));
    expect(implementPhase?.status).toBe('failed');
    expect(implementPhase?.failure?.kind).toBe('phase_boundary_violation');
  });

  it('allows clean non-implement phase resume without step baseline', async () => {
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write'],
    });

    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'issue.md',
      contents: '# Issue',
    });
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'issue-comments.md',
      contents: '[]',
    });
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'design.md',
      contents: '# Design',
    });
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'plan.md',
      contents: '# Plan',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: '# Log',
    });

    const git = new FakeGitPort();
    git.statusByCwd.set('/tmp/worktree', '');

    const planReviewSpy = vi.fn(async () => ({ outcome: 'passed' as const }));
    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, vi.fn());
    registry.register({
      phase: makePhaseName('plan-review'),
      run: planReviewSpy,
    });

    const deps = makeDeps({
      registry,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'reset_to_baseline',
    });

    expect(result.run.status).toBe('passed');
    expect(planReviewSpy).toHaveBeenCalled();
  });

  it('escalates dirty non-implement phase resume when baseline is absent', async () => {
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write'],
    });

    const git = new FakeGitPort();
    git.statusByCwd.set('/tmp/worktree', '?? dirty.ts\n');

    const planReviewSpy = vi.fn();
    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, vi.fn());
    registry.register({
      phase: makePhaseName('plan-review'),
      run: planReviewSpy,
    });

    const deps = makeDeps({
      registry,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          cwd: '/tmp/worktree',
          artifacts: new FakeArtifactStore(),
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'reset_to_baseline',
    });

    expect(result.run.status).toBe('needs_human_review');
    expect(planReviewSpy).not.toHaveBeenCalled();
  });

  it('fresh jobs skip resume preparation', async () => {
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write'],
    });

    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'issue.md',
      contents: '# Issue',
    });
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'issue-comments.md',
      contents: '[]',
    });
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'design.md',
      contents: '# Design',
    });
    await artifacts.write({
      runId: run.uuid,
      relativePath: 'plan.md',
      contents: '# Plan',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: '# Log',
    });

    const git = new FakeGitPort();
    // Even if status has dirty files, fresh jobs (no resumeDisposition) do not do resume preparation
    git.statusByCwd.set('/tmp/worktree', '?? uncommitted.ts\n');

    const lifecycle = new FakeWorktreeLifecycle();
    const planReviewSpy = vi.fn(async () => ({ outcome: 'passed' as const }));

    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, vi.fn());
    registry.register({
      phase: makePhaseName('plan-review'),
      run: planReviewSpy,
    });

    const deps = makeDeps({
      registry,
      worktreeLifecycle: lifecycle,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      // resumeDisposition is undefined (fresh job)
    });

    expect(result.run.status).toBe('passed');
    expect(lifecycle.inspectCalls).toHaveLength(0);
    expect(lifecycle.executeCalls).toHaveLength(0);
    expect(planReviewSpy).toHaveBeenCalled();
  });

  it('defers to the implement phase inbound audit when step baseline is absent, instead of escalating on ambient dirt', async () => {
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    const artifacts = new FakeArtifactStore();
    await writeCompletedPhaseArtifacts(artifacts, run.uuid);
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'plan-write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({ version: 1, task_count: 1, tasks: [{ n: 1, title: 'Task 1' }] }),
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'plan-review',
      relativePath: 'plan-review-findings.md',
      contents: '# Findings',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'plan-review',
      relativePath: 'plan-fix-result.json',
      contents: '{}',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'plan-review',
      relativePath: 'plan-review-passed.marker',
      contents: '',
    });

    const git = new FakeGitPort();
    git.statusByCwd.set('/tmp/worktree', '?? ambient-drift.ts\n');

    const implementSpy = vi.fn(async () => ({ outcome: 'passed' as const }));
    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, vi.fn());
    registry.register({
      phase: makePhaseName('implement'),
      run: implementSpy,
    });

    const stepRepo = new FakeStepRepository();
    const lifecycle = new FakeWorktreeLifecycle();
    lifecycle.planToReturn = {
      mode: 'phase_boundary',
      cwd: '/tmp/worktree',
      targetBaseline: undefined,
      fingerprint: 'fp-drift',
      discardedPaths: ['ambient-drift.ts'],
      preservedPaths: [],
      trackedChanges: [],
      untrackedPaths: ['ambient-drift.ts'],
    };

    const eventRepo = new FakeEventRepository();
    const deps = makeDeps({
      registry,
      stepRepository: stepRepo,
      worktreeLifecycle: lifecycle,
      eventRepository: eventRepo,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'reset_to_baseline',
    });

    // RunExecutor's own dirty-worktree gate is scoped to non-implement phases;
    // a fresh implement resume (no in-progress step) must not be rejected here
    // for ambient plan-review residue — that is ImplementHandler's own audited
    // inbound cleanup to make. The requested disposition is still recorded so
    // it isn't silently dropped.
    expect(implementSpy).toHaveBeenCalled();
    expect(result.run.status).toBe('passed');
    expect(
      eventRepo.events.some(
        (e) =>
          e.type === 'run.resume_disposition_deferred' &&
          e.metadata?.resumeDisposition === 'reset_to_baseline',
      ),
    ).toBe(true);
  });

  it('allows clean implement phase resume without step baseline', async () => {
    const run = makeRun({
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    const artifacts = new FakeArtifactStore();
    await writeCompletedPhaseArtifacts(artifacts, run.uuid);
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'plan-write',
      relativePath: 'task-manifest.json',
      contents: JSON.stringify({ version: 1, task_count: 1, tasks: [{ n: 1, title: 'Task 1' }] }),
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'plan-review',
      relativePath: 'plan-review-findings.md',
      contents: '# Findings',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'plan-review',
      relativePath: 'plan-fix-result.json',
      contents: '{}',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'plan-review',
      relativePath: 'plan-review-passed.marker',
      contents: '',
    });
    await artifacts.write({
      runId: run.uuid,
      phaseId: 'implement',
      relativePath: 'implementation-log.md',
      contents: '# Done',
    });

    const git = new FakeGitPort();
    git.statusByCwd.set('/tmp/worktree', '');

    const implementSpy = vi.fn(async () => ({ outcome: 'passed' as const }));
    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, vi.fn());
    registry.register({
      phase: makePhaseName('implement'),
      run: implementSpy,
    });

    const stepRepo = new FakeStepRepository();
    const lifecycle = new FakeWorktreeLifecycle();

    const deps = makeDeps({
      registry,
      stepRepository: stepRepo,
      worktreeLifecycle: lifecycle,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'reset_to_baseline',
    });

    expect(result.run.status).toBe('passed');
    expect(implementSpy).toHaveBeenCalled();
  });

  it('preserve_working_tree succeeds for lean executionPolicy without requiring task-manifest.json', async () => {
    const run = makeRun({
      executionPolicy: 'standard',
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    const stepRepo = new FakeStepRepository();
    stepRepo.upsert({
      id: 'step-1',
      runId: run.uuid,
      phaseId: 'implement',
      index: 1,
      title: 'Implement issue',
      status: 'failed',
      initialPreStepHead: 'baseline-sha-1111',
      revertCounts: {},
    });

    const artifacts = new FakeArtifactStore();
    await writeCompletedPhaseArtifacts(artifacts, run.uuid);
    // Notice: NO task-manifest.json artifact written!

    const git = new FakeGitPort();
    git.statusByCwd.set('/tmp/worktree', ' M src/helper.ts\n M src/caller.ts\n');

    const lifecycle = new FakeWorktreeLifecycle();
    const eventRepo = new FakeEventRepository();
    let capturedApprovedPaths: string[] | undefined;

    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, vi.fn());
    registry.register({
      phase: makePhaseName('implement'),
      run: async (ctx) => {
        capturedApprovedPaths = ctx.approvedInboundPaths;
        return { outcome: 'passed' };
      },
    });

    const deps = makeDeps({
      registry,
      stepRepository: stepRepo,
      eventRepository: eventRepo,
      worktreeLifecycle: lifecycle,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'preserve_working_tree',
    });

    expect(result.run.status).toBe('passed');
    expect(lifecycle.executeCalls).toHaveLength(0); // Git never mutated
    expect(capturedApprovedPaths).toEqual(['src/caller.ts', 'src/helper.ts']);
  });

  it('preserve_working_tree rejects protected files under lean executionPolicy', async () => {
    const run = makeRun({
      executionPolicy: 'standard',
      completedPhases: ['read_issue', 'plan-design', 'plan-write', 'plan-review'],
    });

    const stepRepo = new FakeStepRepository();
    stepRepo.upsert({
      id: 'step-1',
      runId: run.uuid,
      phaseId: 'implement',
      index: 1,
      title: 'Implement issue',
      status: 'failed',
      initialPreStepHead: 'baseline-sha-1111',
      revertCounts: {},
    });

    const artifacts = new FakeArtifactStore();
    await writeCompletedPhaseArtifacts(artifacts, run.uuid);

    const git = new FakeGitPort();
    git.statusByCwd.set('/tmp/worktree', ' M .gitignore\n M src/helper.ts\n');

    const lifecycle = new FakeWorktreeLifecycle();
    const eventRepo = new FakeEventRepository();
    const implementSpy = vi.fn();

    const registry = new PhaseHandlerRegistry();
    registerPassThroughHandlers(registry, implementSpy);

    const deps = makeDeps({
      registry,
      stepRepository: stepRepo,
      eventRepository: eventRepo,
      worktreeLifecycle: lifecycle,
      contextFactory: (_r) =>
        ({
          runId: run.displayId,
          runUuid: run.uuid,
          cwd: '/tmp/worktree',
          artifacts,
          git,
          events: { publish: vi.fn(), subscribe: vi.fn().mockReturnValue(() => {}) },
          now: () => FIXED_NOW,
        }) as unknown as PhaseHandlerContext,
    });

    const executor = new RunExecutor(deps);
    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
      resumeDisposition: 'preserve_working_tree',
    });

    expect(result.run.status).toBe('needs_human_review');
    expect(lifecycle.executeCalls).toHaveLength(0);
    expect(implementSpy).not.toHaveBeenCalled();
  });
});
