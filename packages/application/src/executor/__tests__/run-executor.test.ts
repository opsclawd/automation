import { describe, it, expect, vi } from 'vitest';
import { createRun, type Run, type Failure, PhaseName as makePhaseName } from '@ai-sdlc/domain';
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
  'review-fix',
  'compound',
  'create-pr',
  'post-pr-review',
] as const;

// Only the artifacts needed to satisfy required inputs for all phases in a full pipeline run.
// Not a comprehensive list of all phase outputs — just the minimum to avoid MissingRequiredInputError.
const MINIMAL_ARTIFACTS_FOR_FULL_PIPELINE = ['issue.md', 'design.md', 'plan.md', 'pr-url.txt'];

function makeRun(overrides?: Partial<Run>): Run {
  return createRun({
    uuid: 'test-uuid',
    displayId: 'run-1',
    issueNumber: 42,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
}

function makeStubHandler(
  phase: string,
  outcome: 'passed' | 'failed' | 'blocked' | 'resting' | 'skipped' = 'passed',
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

function makeDeps(overrides?: {
  runRepository?: Partial<RunRepositoryPort>;
  failureRepository?: Partial<FailureRepositoryPort>;
  phaseRepository?: PhaseRepositoryPort;
  events?: Partial<EventBusPort>;
  registry?: PhaseHandlerRegistry;
  contextFactory?: () => PhaseHandlerContext;
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
      (() => ({
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

    const input: ExecuteRunInput = {
      run,
      skip: [],
      presentArtifacts: MINIMAL_ARTIFACTS_FOR_FULL_PIPELINE,
    };

    const result = await executor.execute(input);

    expect(result.run.status).toBe('passed');
    expect(result.phases).toHaveLength(9);
    for (const pr of result.phases) {
      expect(pr.status).toBe('passed');
    }

    // Verify runRepository.update called for each phase start + completion + final pass
    // 9 phase starts + 9 completions + 1 final pass = 19
    expect(deps.runRepository.update).toHaveBeenCalledTimes(19);
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
      presentArtifacts: MINIMAL_ARTIFACTS_FOR_FULL_PIPELINE,
    };

    const result = await executor.execute(input);

    // Skipped phases are recorded
    const skippedPhases = result.phases.filter((p) => p.status === 'skipped');
    expect(skippedPhases).toHaveLength(1);
    expect(skippedPhases[0]!.phase).toBe(makePhaseName('compound'));

    const passedPhases = result.phases.filter((p) => p.status === 'passed');
    expect(passedPhases).toHaveLength(8);

    expect(result.run.status).toBe('passed');

    // Skipped phases persisted via insert
    const skippedInserts = phaseRepo.inserted.filter((p) => p.status === 'skipped');
    expect(skippedInserts).toHaveLength(1);
  });

  it('treats resting outcome as passed — phase completes, run continues', async () => {
    const registry = new PhaseHandlerRegistry();
    registry.register(makeStubHandler('read_issue', 'resting'));
    for (const name of ALL_PHASES.slice(1)) {
      registry.register(makeStubHandler(name));
    }

    const deps = makeDeps({ registry });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = {
      run,
      skip: [],
      presentArtifacts: MINIMAL_ARTIFACTS_FOR_FULL_PIPELINE,
    };
    const result = await executor.execute(input);

    expect(result.run.status).toBe('passed');
    expect(result.phases).toHaveLength(9);
    // The first phase recorded as passed even though handler returned 'resting'
    expect(result.phases[0]!.status).toBe('passed');
    expect(result.phases[8]!.status).toBe('passed');
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

  it('missing required input produces a failure with kind missing_artifact', async () => {
    const registry = new PhaseHandlerRegistry();
    registry.register(makeStubHandler('read_issue'));
    registry.register(makeStubHandler('plan-design'));

    const deps = makeDeps({ registry });
    const executor = new RunExecutor(deps);
    const run = makeRun();

    const input: ExecuteRunInput = {
      run,
      skip: [],
      presentArtifacts: [], // missing 'issue.md' which plan-design requires
    };

    const result = await executor.execute(input);

    // read_issue passes (no required inputs), plan-design fails on missing input
    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('missing required inputs: issue.md');
    const failedPhase = result.phases.find((p) => p.status === 'failed');
    expect(failedPhase).toBeDefined();
    expect(failedPhase!.phase).toBe(makePhaseName('plan-design'));
    expect(deps.failureRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'missing_artifact', canRetry: false }),
    );
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
      presentArtifacts: MINIMAL_ARTIFACTS_FOR_FULL_PIPELINE,
    };
    await executor.execute(input);

    // Verify phase inserts: each phase starts with status 'running'
    const runningInserts = phaseRepo.inserted.filter((p) => p.status === 'running');
    expect(runningInserts).toHaveLength(9);

    // Verify phase updates: each phase updated to 'passed'
    const passedUpdates = phaseRepo.updated.filter((p) => p.status === 'passed');
    expect(passedUpdates).toHaveLength(9);

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
});
