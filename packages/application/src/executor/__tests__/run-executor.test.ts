import { describe, it, expect, vi } from 'vitest';
import {
  createRun,
  type Run,
  type Failure,
  PhaseName as makePhaseName,
  RepositoryId,
} from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../../phases/handler.js';
import { PhaseHandlerRegistry } from '../phase-handler-registry.js';
import type { RunRepositoryPort, FailureRepositoryPort, EventBusPort } from '../../ports.js';
import type { PhaseRepositoryPort } from '../../ports/phase-repository-port.js';
import { RunExecutor } from '../run-executor.js';
import type { ExecuteRunInput } from '../run-executor.js';
import { FakePhaseRepository } from '../../test-doubles/fake-phase-repository.js';

const ALL_PHASES = [
  'read_issue',
  'plan-design',
  'plan-write',
  'implement',
  'validate',
  'fix-validate',
  'review-fix',
  'compound',
  'create-pr',
  'post-pr-review',
] as const;

function makeRun(overrides?: Partial<Run>): Run {
  return createRun({
    uuid: 'test-uuid',
    displayId: 'run-1',
    repoId: RepositoryId('acme/widgets'),
    issueNumber: 42,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
}

function makeStubHandler(
  phase: string,
  outcome:
    | 'passed'
    | 'failed'
    | 'blocked'
    | 'needs_human_review'
    | 'resting'
    | 'skipped'
    | 'deferred' = 'passed',
): PhaseHandler {
  return {
    phase: makePhaseName(phase),
    run: async (_ctx: PhaseHandlerContext): Promise<PhaseResult> => {
      if (outcome === 'failed') {
        return {
          outcome: 'failed',
          failure: makeFailure(phase),
        };
      }
      if (outcome === 'blocked') {
        return {
          outcome: 'blocked',
          failure: makeFailure(phase, 'agent_blocked'),
        };
      }
      if (outcome === 'needs_human_review') {
        return {
          outcome: 'needs_human_review',
          failure: makeFailure(phase, 'agent_incomplete'),
        };
      }
      return { outcome };
    },
  };
}

function makeFailure(phase: string, kind: Failure['kind'] = 'command_failed'): Failure {
  return {
    runUuid: 'test-uuid',
    phase,
    kind,
    message: `handler ${phase} failed`,
    canRetry: false,
    suggestedAction: 'fix it',
    artifacts: [],
    detectedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function registerAllPassed(registry: PhaseHandlerRegistry): void {
  for (const name of ALL_PHASES) {
    registry.register(makeStubHandler(name));
  }
}

const fixedNow = new Date('2026-01-01T00:00:00Z');

function contextFactoryWithStoredArtifacts(paths: string[]): (run: Run) => PhaseHandlerContext {
  const stored = paths.map((p) => ({
    runId: 'test-uuid',
    relativePath: p,
    absolutePath: `/tmp/${p}`,
    bytes: p.length,
    createdAt: fixedNow,
  }));
  return (_run: Run) => ({
    runId: 'test-uuid',
    runUuid: 'test-uuid',
    repoFullName: 'acme/widgets',
    issueNumber: 42,
    cwd: '/tmp/worktree',
    artifacts: {
      read: async () => '',
      write: async () => ({
        runId: 'test-uuid',
        relativePath: '',
        absolutePath: '',
        bytes: 0,
        createdAt: fixedNow,
      }),
      list: async () => stored,
    },
    github: {} as never,
    git: {} as never,
    agent: {} as never,
    events: {
      publish: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => {}),
    },
    now: () => fixedNow,
  });
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
        runUuid: 'test-uuid',
        repoFullName: 'acme/widgets',
        issueNumber: 42,
        cwd: '/tmp/worktree',
        artifacts: {
          read: async () => '',
          write: async () => ({
            runId: 'test-uuid',
            relativePath: '',
            absolutePath: '',
            bytes: 0,
            createdAt: fixedNow,
          }),
          list: async () => [],
        },
        github: {} as never,
        git: {} as never,
        agent: {} as never,
        events: overrides?.events ?? {
          publish: vi.fn(),
          subscribe: vi.fn().mockReturnValue(() => {}),
        },
        now: () => fixedNow,
      })),
    now: () => fixedNow,
  };
}

describe('RunExecutor', () => {
  it('advances all phases sequentially and marks run passed', async () => {
    const registry = new PhaseHandlerRegistry();
    registerAllPassed(registry);

    const deps = makeDeps({ registry });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    // No preloaded artifacts — the executor accumulates declared outputs from each
    // completed phase, satisfying downstream required inputs automatically.
    const input: ExecuteRunInput = {
      run,
      skip: [],
      presentArtifacts: [],
    };

    const result = await executor.execute(input);

    expect(result.run.status).toBe('passed');
    expect(result.phases).toHaveLength(10);
    for (const pr of result.phases) {
      expect(pr.status).toBe('passed');
    }

    // Verify runRepository.update called for each phase start + completion + final pass
    // 10 phase starts + 10 completions + 1 final pass = 21
    expect(deps.runRepository.update).toHaveBeenCalledTimes(21);
  });

  it('records skipped phases and does not execute them', async () => {
    const registry = new PhaseHandlerRegistry();
    registerAllPassed(registry);

    const phaseRepo = new FakePhaseRepository();
    const deps = makeDeps({ registry, phaseRepository: phaseRepo });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = {
      run,
      skip: [makePhaseName('compound')],
      presentArtifacts: [],
    };

    const result = await executor.execute(input);

    // Skipped phases are recorded
    const skippedPhases = result.phases.filter((p) => p.status === 'skipped');
    expect(skippedPhases).toHaveLength(1);
    expect(skippedPhases[0]!.phase).toBe(makePhaseName('compound'));

    const passedPhases = result.phases.filter((p) => p.status === 'passed');
    expect(passedPhases).toHaveLength(9);

    expect(result.run.status).toBe('passed');

    // Skipped phases persisted via insert
    const skippedInserts = phaseRepo.inserted.filter((p) => p.status === 'skipped');
    expect(skippedInserts).toHaveLength(1);

    // Run's skippedPhases includes the skipped phase
    expect(result.run.skippedPhases).toEqual(['compound']);

    // Run repository updated with skippedPhases
    expect(deps.runRepository.update).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ skippedPhases: ['compound'] }),
    );
  });

  it('preserves handler-returned skipped outcome — status is skipped, no outputs accumulated', async () => {
    const registry = new PhaseHandlerRegistry();
    registry.register(makeStubHandler('read_issue'));
    registry.register(makeStubHandler('plan-design', 'skipped'));
    registry.register(makeStubHandler('plan-write'));

    const phaseRepo = new FakePhaseRepository();
    const deps = makeDeps({ registry, phaseRepository: phaseRepo });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = {
      run,
      skip: [],
      presentArtifacts: [],
    };
    const result = await executor.execute(input);

    // read_issue passes, plan-design's handler returned skipped, plan-write's
    // input gate fails because design.md was never accumulated as present
    expect(result.phases).toHaveLength(3);
    expect(result.phases[0]!.status).toBe('passed');
    expect(result.phases[0]!.phase).toBe(makePhaseName('read_issue'));
    expect(result.phases[1]!.status).toBe('skipped');
    expect(result.phases[1]!.phase).toBe(makePhaseName('plan-design'));
    // plan-write is recorded as failed because its required input (design.md)
    // was never accumulated — the skipped handler did not produce it
    expect(result.phases[2]!.status).toBe('failed');
    expect(result.phases[2]!.phase).toBe(makePhaseName('plan-write'));

    // Skipped phase persisted via update (started as running, then updated to skipped)
    const skippedUpdates = phaseRepo.updated.filter((p) => p.status === 'skipped');
    expect(skippedUpdates).toHaveLength(1);
    expect(skippedUpdates[0]!.name).toBe('plan-design');

    // Event published for phase.skipped (not phase.completed)
    expect(deps.events.publish).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({
        type: 'phase.skipped',
        phase: 'plan-design',
      }),
    );

    // The run fails because of the missing_artifact on plan-write
    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain("phase 'plan-write'");
  });

  it('stops the phase loop on resting — no subsequent phases, phase status preserved, run not passed', async () => {
    const registry = new PhaseHandlerRegistry();
    registry.register(makeStubHandler('read_issue', 'resting'));
    // Register handler for next phase — should NOT be reached
    registry.register(makeStubHandler('plan-design'));

    const deps = makeDeps({ registry });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = {
      run,
      skip: [],
      presentArtifacts: [],
    };
    const result = await executor.execute(input);

    // Only the resting phase executed
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.status).toBe('resting');
    expect(result.phases[0]!.phase).toBe(makePhaseName('read_issue'));

    // Run is NOT passed — it retains its pre-passRun status
    expect(result.run.status).not.toBe('passed');
    expect(result.run.currentPhase).toBeUndefined();
    expect(result.run.completedPhases).toEqual([]);

    // Event reflects resting, not completion
    expect(deps.events.publish).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ type: 'phase.resting' }),
    );
    expect(deps.events.publish).not.toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ type: 'run.completed' }),
    );
  });

  it('advances past a deferred outcome — phase recorded as deferred, pipeline continues', async () => {
    const registry = new PhaseHandlerRegistry();
    registerAllPassed(registry);
    registry.register(makeStubHandler('plan-design', 'deferred'));

    const phaseRepo = new FakePhaseRepository();
    const deps = makeDeps({ registry, phaseRepository: phaseRepo });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = {
      run,
      skip: [],
      presentArtifacts: ['issue.md'],
    };

    const result = await executor.execute(input);

    // plan-design recorded as deferred (not passed) in phase records
    const planDesign = result.phases.find((p) => p.phase === makePhaseName('plan-design'));
    expect(planDesign).toBeDefined();
    expect(planDesign!.status).toBe('deferred');

    // Pipeline continued — all subsequent phases executed
    expect(result.phases).toHaveLength(10);
    expect(result.run.status).toBe('passed');
    expect(result.run.completedPhases).toContain('plan-design');

    // Phase was updated to deferred (not left as running)
    const deferredUpdates = phaseRepo.updated.filter((p) => p.status === 'deferred');
    expect(deferredUpdates).toHaveLength(1);
    expect(deferredUpdates[0]!.name).toBe('plan-design');

    // phase.completed event emitted for the deferred phase
    expect(deps.events.publish).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ type: 'phase.completed', phase: 'plan-design' }),
    );
  });

  it('stops on first phase failure and marks run failed', async () => {
    const registry = new PhaseHandlerRegistry();
    registry.register(makeStubHandler('read_issue', 'failed'));
    // Other handlers not needed — execution stops at read_issue

    const deps = makeDeps({ registry });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = { run, skip: [], presentArtifacts: [] };
    const result = await executor.execute(input);

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toBe('handler read_issue failed');
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.status).toBe('failed');
    expect(result.phases[0]!.failure).toBeDefined();
    expect(result.phases[0]!.failure!.kind).toBe('command_failed');

    // Failure was persisted
    expect(deps.failureRepository.insert).toHaveBeenCalledTimes(1);
  });

  it('stops mid-pipeline on failure — earlier phases passed, later not reached', async () => {
    const registry = new PhaseHandlerRegistry();
    registry.register(makeStubHandler('read_issue'));
    registry.register(makeStubHandler('plan-design', 'failed'));
    // Other handlers not needed — execution stops at plan-design

    const deps = makeDeps({ registry });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = { run, skip: [], presentArtifacts: ['issue.md'] };
    const result = await executor.execute(input);

    expect(result.run.status).toBe('failed');
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0]!.status).toBe('passed');
    expect(result.phases[1]!.status).toBe('failed');
  });

  describe('invariant 1 — run cannot be passed when a required phase failed', () => {
    it('keeps the run failed when a required phase handler returns failed', async () => {
      const registry = new PhaseHandlerRegistry();
      registry.register(makeStubHandler('read_issue', 'failed'));

      const deps = makeDeps({ registry });
      const executor = new RunExecutor(deps);
      const run = makeRun();

      const input: ExecuteRunInput = { run, skip: [], presentArtifacts: [] };
      const result = await executor.execute(input);

      expect(result.run.status).not.toBe('passed');
      expect(result.run.status).toBe('failed');
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.status).toBe('failed');
    });

    it('keeps the run blocked when a required phase handler returns blocked', async () => {
      const registry = new PhaseHandlerRegistry();
      registry.register(makeStubHandler('read_issue', 'blocked'));

      const deps = makeDeps({ registry });
      const executor = new RunExecutor(deps);
      const run = makeRun();

      const input: ExecuteRunInput = { run, skip: [], presentArtifacts: [] };
      const result = await executor.execute(input);

      expect(result.run.status).not.toBe('passed');
      expect(result.run.status).toBe('blocked');
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.status).toBe('blocked');
    });

    it('keeps the run in needs_human_review when a required phase handler returns needs_human_review', async () => {
      const registry = new PhaseHandlerRegistry();
      registry.register(makeStubHandler('read_issue', 'needs_human_review'));

      const deps = makeDeps({ registry });
      const executor = new RunExecutor(deps);
      const run = makeRun();

      const input: ExecuteRunInput = { run, skip: [], presentArtifacts: [] };
      const result = await executor.execute(input);

      expect(result.run.status).not.toBe('passed');
      expect(result.run.status).toBe('needs_human_review');
      expect(result.phases).toHaveLength(1);
      expect(result.phases[0]!.status).toBe('needs_human_review');
    });
  });

  it('handles blocked outcome — marks run blocked with failure', async () => {
    const registry = new PhaseHandlerRegistry();
    registry.register(makeStubHandler('read_issue', 'blocked'));
    // Other handlers not needed — execution stops at read_issue

    const deps = makeDeps({ registry });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = { run, skip: [], presentArtifacts: [] };
    const result = await executor.execute(input);

    expect(result.run.status).toBe('blocked');
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.status).toBe('blocked');
    expect(result.phases[0]!.failure).toBeDefined();
    expect(deps.failureRepository.insert).toHaveBeenCalledTimes(1);
    // Verify runRepository.update was called with blocked status
    expect(deps.runRepository.update).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ status: 'blocked' }),
    );
  });

  it('handles needs_human_review outcome — marks run needs_human_review with failure', async () => {
    const registry = new PhaseHandlerRegistry();
    registry.register(makeStubHandler('read_issue', 'needs_human_review'));

    const deps = makeDeps({ registry });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = { run, skip: [], presentArtifacts: [] };
    const result = await executor.execute(input);

    expect(result.run.status).toBe('needs_human_review');
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.status).toBe('needs_human_review');
    expect(result.phases[0]!.failure).toBeDefined();
    expect(result.phases[0]!.failure!.kind).toBe('agent_incomplete');
    expect(deps.failureRepository.insert).toHaveBeenCalledTimes(1);
    expect(deps.runRepository.update).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ status: 'needs_human_review' }),
    );
  });

  it('accumulates declared outputs from completed phases, satisfying downstream required inputs', async () => {
    const registry = new PhaseHandlerRegistry();
    registerAllPassed(registry);

    const deps = makeDeps({ registry });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = {
      run,
      skip: [],
      presentArtifacts: [], // no preloaded artifacts
    };

    const result = await executor.execute(input);

    // No preloaded artifacts, yet all phases pass because each completed phase's
    // declared outputs are appended to presentArtifacts, satisfying downstream inputs.
    expect(result.run.status).toBe('passed');
    expect(result.phases).toHaveLength(10);
    for (const pr of result.phases) {
      expect(pr.status).toBe('passed');
    }
  });

  it('handles handler throwing an exception — converts to command_failed failure', async () => {
    const registry = new PhaseHandlerRegistry();
    registry.register({
      phase: makePhaseName('read_issue'),
      run: async () => {
        throw new Error('handler crash');
      },
    });

    const phaseRepo = new FakePhaseRepository();
    const deps = makeDeps({ registry, phaseRepository: phaseRepo });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = { run, skip: [], presentArtifacts: [] };
    const result = await executor.execute(input);

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toBe('handler crash');
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.status).toBe('failed');
    expect(result.phases[0]!.failure).toBeDefined();
    expect(result.phases[0]!.failure!.kind).toBe('command_failed');
    expect(result.phases[0]!.failure!.message).toBe('handler crash');

    expect(deps.failureRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'command_failed', message: 'handler crash' }),
    );

    // Phase was inserted with startedAt before handler ran, so failRun calls update
    const phaseUpdates = phaseRepo.updated.filter((p) => p.status === 'failed');
    expect(phaseUpdates).toHaveLength(1);

    // Events published for phase.failed and run.failed
    expect(deps.events.publish).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ type: 'phase.failed', level: 'error' }),
    );
    expect(deps.events.publish).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ type: 'run.failed', level: 'error' }),
    );
  });

  it('propagates InvalidSkipListError when skip list contains non-skippable phase', async () => {
    const registry = new PhaseHandlerRegistry();
    const deps = makeDeps({ registry });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = {
      run,
      skip: [makePhaseName('create-pr')],
      presentArtifacts: [],
    };

    await expect(executor.execute(input)).rejects.toThrow('not skippable');
  });

  it('throws UnregisteredPhaseError when registry has no handler for a phase', async () => {
    const registry = new PhaseHandlerRegistry();
    const deps = makeDeps({ registry });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = { run, skip: [], presentArtifacts: [] };

    await expect(executor.execute(input)).rejects.toThrow('no PhaseHandler registered');
  });

  it('persists state via repositories at each transition', async () => {
    const registry = new PhaseHandlerRegistry();
    registerAllPassed(registry);

    const phaseRepo = new FakePhaseRepository();
    const deps = makeDeps({ registry, phaseRepository: phaseRepo });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = {
      run,
      skip: [],
      presentArtifacts: [],
    };
    await executor.execute(input);

    // Verify phase inserts: each phase starts with status 'running'
    const runningInserts = phaseRepo.inserted.filter((p) => p.status === 'running');
    expect(runningInserts).toHaveLength(10);

    // Verify phase updates: each phase updated to 'passed'
    const passedUpdates = phaseRepo.updated.filter((p) => p.status === 'passed');
    expect(passedUpdates).toHaveLength(10);

    // Verify run updates: phase start (currentPhase set) + phase complete (currentPhase null) + final pass
    expect(deps.runRepository.update).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ currentPhase: 'read_issue' }),
    );
    expect(deps.runRepository.update).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ currentPhase: null, completedPhases: ['read_issue'] }),
    );
    expect(deps.runRepository.update).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ status: 'passed' }),
    );

    // Verify events published
    expect(deps.events.publish).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ type: 'phase.started' }),
    );
    expect(deps.events.publish).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ type: 'phase.completed' }),
    );
    expect(deps.events.publish).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ type: 'run.completed' }),
    );
  });

  it('stops execution with cancelled status when run was cancelled externally during handler execution', async () => {
    const registry = new PhaseHandlerRegistry();

    const cancelledRun = { ...makeRun(), status: 'cancelled' as const };
    const findByUuid = vi
      .fn()
      .mockReturnValueOnce(undefined) // line 118: before handler
      .mockReturnValueOnce(cancelledRun); // line 148: after handler

    registry.register(makeStubHandler('read_issue'));

    const deps = makeDeps({ registry, runRepository: { findByUuid } });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const result = await executor.execute({ run, skip: [], presentArtifacts: [] });

    expect(result.run.status).toBe('cancelled');
    expect(result.phases).toHaveLength(0);

    expect(deps.runRepository.update).not.toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ status: 'passed' }),
    );
    expect(deps.runRepository.update).not.toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('allows resting handler-owned cancellation to complete phase bookkeeping', async () => {
    // Simulates PostPrReviewHandler's signal=cancelled/timed_out pattern:
    // the handler calls setRunStatus('cancelled') then returns { outcome: 'resting' }.
    // The cancellation guard must not intercept — the resting branch should still
    // update the phase row and clear currentPhase.
    const registry = new PhaseHandlerRegistry();
    registry.register({
      phase: makePhaseName('read_issue'),
      run: async (): Promise<PhaseResult> => ({ outcome: 'resting' }),
    });

    const cancelledRun = { ...makeRun(), status: 'cancelled' as const };
    // First call (pre-handler guard) returns undefined — let the handler run.
    // Second call (post-handler guard) returns cancelledRun.
    const findByUuid = vi.fn().mockReturnValueOnce(undefined).mockReturnValueOnce(cancelledRun);

    const phaseRepo = new FakePhaseRepository();
    const deps = makeDeps({ registry, runRepository: { findByUuid }, phaseRepository: phaseRepo });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const result = await executor.execute({ run, skip: [], presentArtifacts: [] });

    // Phase was updated to resting (not left as running)
    const restingUpdates = phaseRepo.updated.filter((p) => p.status === 'resting');
    expect(restingUpdates).toHaveLength(1);
    expect(restingUpdates[0]!.name).toBe('read_issue');

    // currentPhase cleared — the resting branch runs its bookkeeping
    expect(deps.runRepository.update).toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ currentPhase: null }),
    );

    // Phase recorded as resting (not left as running)
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.status).toBe('resting');
    expect(result.phases[0]!.phase).toBe(makePhaseName('read_issue'));
    // currentPhase cleared in returned run
    expect(result.run.currentPhase).toBeUndefined();
  });

  it('stops execution with cancelled status when handler throws and run was cancelled externally', async () => {
    const registry = new PhaseHandlerRegistry();

    const cancelledRun = { ...makeRun(), status: 'cancelled' as const };
    const findByUuid = vi
      .fn()
      .mockReturnValueOnce(undefined) // line 118: before handler
      .mockReturnValueOnce(cancelledRun); // line 131: catch block

    registry.register({
      phase: makePhaseName('read_issue'),
      run: async () => {
        throw new Error('crash');
      },
    });

    const deps = makeDeps({ registry, runRepository: { findByUuid } });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const result = await executor.execute({ run, skip: [], presentArtifacts: [] });

    expect(result.run.status).toBe('cancelled');
    expect(result.phases).toHaveLength(0);

    expect(deps.runRepository.update).not.toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(deps.failureRepository.insert).not.toHaveBeenCalled();
  });

  it('resumes from first incomplete phase when run has completedPhases', async () => {
    const registry = new PhaseHandlerRegistry();
    registerAllPassed(registry);

    const phaseRepo = new FakePhaseRepository();
    const deps = makeDeps({
      registry,
      phaseRepository: phaseRepo,
      contextFactory: contextFactoryWithStoredArtifacts([
        'issue.md',
        'issue-comments.md',
        'design.md',
      ]),
    });
    const executor = new RunExecutor(deps);

    // Simulate a run that completed read_issue and plan-design before a crash.
    // createRun() always sets completedPhases: [], so we overwrite after creation.
    const resumedRun: Run = {
      ...makeRun(),
      completedPhases: ['read_issue', 'plan-design'],
    };

    const input: ExecuteRunInput = {
      run: resumedRun,
      skip: [],
      presentArtifacts: [],
    };

    const result = await executor.execute(input);

    // Only the 8 remaining phases execute (10 total - 2 completed)
    expect(result.phases).toHaveLength(10);
    expect(result.run.status).toBe('passed');
    expect(result.run.completedPhases).toEqual([
      'read_issue',
      'plan-design',
      'plan-write',
      'implement',
      'validate',
      'fix-validate',
      'review-fix',
      'compound',
      'create-pr',
      'post-pr-review',
    ]);

    // Phase repository should only have inserts for the 8 new phases,
    // not for the already-completed ones
    const runningInserts = phaseRepo.inserted.filter((p) => p.status === 'running');
    expect(runningInserts).toHaveLength(8);

    // runRepository updates: 8 phase starts + 8 completions + 1 final pass = 17
    // (not 21 as when all 10 run from scratch)
    expect(deps.runRepository.update).toHaveBeenCalledTimes(17);

    // Handler for read_issue should never have been called (no new insert for it)
    expect(runningInserts.map((p) => p.name)).not.toContain('read_issue');
    expect(runningInserts.map((p) => p.name)).not.toContain('plan-design');
  });

  it('resumes correctly when run has both completedPhases and skippedPhases', async () => {
    const registry = new PhaseHandlerRegistry();
    registerAllPassed(registry);

    const phaseRepo = new FakePhaseRepository();
    const deps = makeDeps({
      registry,
      phaseRepository: phaseRepo,
      contextFactory: contextFactoryWithStoredArtifacts([
        'issue.md',
        'issue-comments.md',
        'design.md',
        'plan.md',
        'implementation-log.md',
        'code-review.md',
        'pr-summary.md',
        'pr-url.txt',
      ]),
    });
    const executor = new RunExecutor(deps);

    // Simulate a run that completed phases up to create-pr, with compound
    // skipped.  create-pr's handler returned passed, but post-pr-review
    // hasn't run yet — this mirrors the pause-after-resting scenario.
    const resumedRun: Run = {
      ...makeRun(),
      completedPhases: [
        'read_issue',
        'plan-design',
        'plan-write',
        'implement',
        'validate',
        'review-fix',
        'create-pr',
      ],
      skippedPhases: ['compound'],
    };

    const input: ExecuteRunInput = {
      run: resumedRun,
      skip: [makePhaseName('compound')],
      presentArtifacts: [],
    };

    const result = await executor.execute(input);

    // All 10 phases recorded in output
    expect(result.phases).toHaveLength(10);

    // Previously-skipped compound shows as skipped (not re-inserted)
    const compoundPhase = result.phases.find((p) => p.phase === makePhaseName('compound'))!;
    expect(compoundPhase.status).toBe('skipped');

    // Remaining incomplete phase (post-pr-review) executed and passed
    const remainingPhases = result.phases.filter(
      (p) => p.phase === makePhaseName('post-pr-review'),
    );
    expect(remainingPhases).toHaveLength(1);
    expect(remainingPhases[0]!.status).toBe('passed');

    expect(result.run.status).toBe('passed');

    // Phase repo: fix-validate and post-pr-review were inserted (as 'running')
    const runningInserts = phaseRepo.inserted.filter((p) => p.status === 'running');
    expect(runningInserts).toHaveLength(2);
    expect(runningInserts[0]!.name).toBe('fix-validate');
    expect(runningInserts[1]!.name).toBe('post-pr-review');

    // Skipped phases were NOT re-inserted via the skipSet branch
    const skippedInserts = phaseRepo.inserted.filter((p) => p.status === 'skipped');
    expect(skippedInserts).toHaveLength(0);

    // The previously-skipped phase appears in final run's skippedPhases
    expect(result.run.skippedPhases).toEqual(['compound']);
  });

  it('honours cancellation by checking before the final passRun', async () => {
    const registry = new PhaseHandlerRegistry();
    registerAllPassed(registry);

    // Return a cancelled run for every call after the first N calls
    // (which are consumed by the loop iteration checks)
    let callCount = 0;
    const cancelledRun = { ...makeRun(), status: 'cancelled' as const };
    const findByUuid = vi.fn(() => {
      callCount++;
      // Each phase iteration: 2 calls (before handler + after handler) = 18 for 9 phases
      // The 19th call would be the final passRun guard
      return callCount <= 18 ? undefined : cancelledRun;
    });

    const deps = makeDeps({ registry, runRepository: { findByUuid } });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const result = await executor.execute({ run, skip: [], presentArtifacts: [] });

    expect(result.run.status).toBe('cancelled');

    expect(deps.runRepository.update).not.toHaveBeenCalledWith(
      'test-uuid',
      expect.objectContaining({ status: 'passed' }),
    );
  });
});
