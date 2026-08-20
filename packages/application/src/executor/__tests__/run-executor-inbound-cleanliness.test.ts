import { describe, it, expect, vi } from 'vitest';
import { createRun, type Run, PhaseName as makePhaseName, RepositoryId } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../../phases/handler.js';
import { PhaseHandlerRegistry } from '../phase-handler-registry.js';
import type { RunRepositoryPort, FailureRepositoryPort } from '../../ports.js';
import type { PhaseRepositoryPort } from '../../ports/phase-repository-port.js';
import { RunExecutor } from '../run-executor.js';
import type { ExecuteRunInput } from '../run-executor.js';
import { FakePhaseRepository } from '../../test-doubles/fake-phase-repository.js';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { FakeStepRepository } from '../../test-doubles/fake-step-repository.js';
import { ImplementHandler } from '../../phases/handlers/implement.js';

const fixedNow = new Date('2026-01-01T00:00:00Z');

function makeRun(overrides?: Partial<Run>): Run {
  return createRun({
    uuid: 'test-uuid',
    displayId: 'run-1',
    repoId: RepositoryId('acme/widgets'),
    issueNumber: 42,
    startedAt: fixedNow,
    ...overrides,
  });
}

function makeStubHandler(phase: string): PhaseHandler {
  return {
    phase: makePhaseName(phase),
    run: async (_ctx: PhaseHandlerContext): Promise<PhaseResult> => ({ outcome: 'passed' }),
  };
}

function makeDeps(overrides?: {
  runRepository?: Partial<RunRepositoryPort>;
  failureRepository?: Partial<FailureRepositoryPort>;
  phaseRepository?: PhaseRepositoryPort;
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
    },
    registry: overrides?.registry ?? new PhaseHandlerRegistry(),
    contextFactory: overrides?.contextFactory ?? ((_run: Run) => ({}) as PhaseHandlerContext),
    now: () => fixedNow,
  };
}

describe('RunExecutor end-to-end dirty-worktree detection (issue #959)', () => {
  it('passes priorPhaseName=plan-review to implement handler when plan-review dirtied the worktree', async () => {
    const registry = new PhaseHandlerRegistry();
    for (const phase of ['read_issue', 'plan-design', 'plan-write', 'plan-review']) {
      registry.register(makeStubHandler(phase));
    }

    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'test-uuid',
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: work\n',
    });

    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/worktree', 'pre-step');
    git.statusByCwd.set(
      '/tmp/worktree',
      ' M packages/application/src/broken.ts\n?? scratch-probe.ts\n',
    );

    const implementHandler = new ImplementHandler({
      steps: new FakeStepRepository(),
      runStep: vi.fn(async () => ({ outcome: 'success' as const })),
    });
    registry.register(implementHandler);

    const observedPriorPhaseNames: Array<string | undefined> = [];
    const contextFactory = (runForCtx: Run): PhaseHandlerContext => {
      const priorPhaseName = runForCtx.completedPhases[runForCtx.completedPhases.length - 1];
      const ctx = {
        runId: 'run-1',
        runUuid: 'test-uuid',
        repoFullName: 'acme/widgets',
        issueNumber: 42,
        cwd: '/tmp/worktree',
        artifacts,
        github: {} as never,
        git,
        agent: {} as never,
        events: {
          publish: vi.fn(),
          subscribe: vi.fn().mockReturnValue(() => {}),
        },
        now: () => fixedNow,
        ...(priorPhaseName ? { priorPhaseName } : {}),
      } satisfies PhaseHandlerContext;
      observedPriorPhaseNames.push(ctx.priorPhaseName);
      return ctx;
    };

    const deps = makeDeps({ registry, contextFactory });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = {
      run,
      skip: [],
      presentArtifacts: ['plan.md'],
    };
    const result = await executor.execute(input);

    // implement's handler must have observed a priorPhaseName from the live run,
    // not from the initial parameter (which would always be undefined).
    expect(observedPriorPhaseNames.length).toBeGreaterThan(0);
    expect(observedPriorPhaseNames[observedPriorPhaseNames.length - 1]).toBe('plan-review');

    const implementPhase = result.phases.find((p) => p.phase === makePhaseName('implement'));
    expect(implementPhase).toBeDefined();
    expect(implementPhase!.status).toBe('failed');
  });

  it('does not fail implement when priorPhaseName is undefined (legacy/un-wired callers)', async () => {
    const registry = new PhaseHandlerRegistry();
    for (const phase of [
      'read_issue',
      'plan-design',
      'plan-write',
      'plan-review',
      'validate',
      'fix-validate',
      'review-fix',
      'compound',
      'create-pr',
      'post-pr-review',
    ]) {
      registry.register(makeStubHandler(phase));
    }

    const artifacts = new FakeArtifactStore();
    await artifacts.write({
      runId: 'test-uuid',
      relativePath: 'plan.md',
      contents: '# Plan\n\n## Task 1: work\n',
    });

    const git = new FakeGitPort();
    git.headByCwd.set('/tmp/worktree', 'pre-step');
    git.statusByCwd.set('/tmp/worktree', '');

    const implementHandler = new ImplementHandler({
      steps: new FakeStepRepository(),
      runStep: vi.fn(async () => ({ outcome: 'success' as const })),
    });
    registry.register(implementHandler);

    const deps = makeDeps({
      registry,
      contextFactory: ((_run: Run) => ({
        runId: 'run-1',
        runUuid: 'test-uuid',
        repoFullName: 'acme/widgets',
        issueNumber: 42,
        cwd: '/tmp/worktree',
        artifacts,
        github: {} as never,
        git,
        agent: {} as never,
        events: {
          publish: vi.fn(),
          subscribe: vi.fn().mockReturnValue(() => {}),
        },
        now: () => fixedNow,
      })) as (run: Run) => PhaseHandlerContext,
    });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = {
      run,
      skip: [],
      presentArtifacts: ['plan.md'],
    };
    const result = await executor.execute(input);

    const implementPhase = result.phases.find((p) => p.phase === makePhaseName('implement'));
    expect(implementPhase!.status).toBe('passed');
  });
});
