import { describe, it, expect } from 'vitest';
import { RunExecutor } from '../run-executor.js';
import { PhaseHandlerRegistry } from '../phase-handler-registry.js';
import type { PhaseHandler, PhaseHandlerContext } from '../../phases/handler.js';
import type { Run } from '@ai-sdlc/domain';
import { createRun, PhaseName as makePhaseName } from '@ai-sdlc/domain';
import {
  FakeRunRepository,
  FakePhaseRepository,
  FakeFailureRepository,
  FakeArtifactStore,
  FakeEventBus,
} from '../../test-doubles/index.js';

function makeRun(overrides?: Partial<Run>): Run {
  return createRun({
    uuid: 'test-uuid',
    displayId: 'run-42',
    issueNumber: 42,
    startedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
}

function makeHandler(phase: string): PhaseHandler {
  return {
    phase: makePhaseName(phase),
    run: async (_ctx: PhaseHandlerContext) => ({ outcome: 'passed' as const }),
  };
}

describe('RunExecutor end-to-end', () => {
  it('completes a full run through all 9 phases with in-memory fakes', async () => {
    const runRepo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    const failureRepo = new FakeFailureRepository();
    const artifactStore = new FakeArtifactStore();
    const eventBus = new FakeEventBus();

    const run = makeRun();
    runRepo.addRun({ ...run, startCommitSha: 'abc123' });

    const registry = new PhaseHandlerRegistry();
    const phases = [
      'read_issue',
      'plan-design',
      'plan-write',
      'implement',
      'validate',
      'review-fix',
      'compound',
      'create-pr',
      'post-pr-review',
    ];
    for (const p of phases) {
      registry.register(makeHandler(p));
    }

    const executor = new RunExecutor({
      runRepository: runRepo,
      failureRepository: failureRepo,
      phaseRepository: phaseRepo,
      events: eventBus,
      registry,
      contextFactory: () => ({
        runId: run.uuid,
        runUuid: run.uuid,
        repoFullName: 'owner/repo',
        issueNumber: run.issueNumber,
        cwd: '/tmp/test-worktree',
        artifacts: artifactStore,
        github: {} as never,
        git: {} as never,
        agent: {} as never,
        events: eventBus,
        now: () => new Date('2026-01-01T00:00:00Z'),
      }),
    });

    const result = await executor.execute({
      run,
      skip: [],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('passed');
    expect(result.phases).toHaveLength(9);
    for (const phase of result.phases) {
      expect(phase.status).toBe('passed');
    }
  });

  it('persists state after each phase transition', async () => {
    const runRepo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    const failureRepo = new FakeFailureRepository();
    const artifactStore = new FakeArtifactStore();
    const eventBus = new FakeEventBus();

    const run = makeRun();
    runRepo.addRun({ ...run, startCommitSha: 'abc123' });

    const registry = new PhaseHandlerRegistry();
    const phases = [
      'read_issue',
      'plan-design',
      'plan-write',
      'implement',
      'validate',
      'review-fix',
      'compound',
      'create-pr',
      'post-pr-review',
    ];
    for (const p of phases) {
      registry.register(makeHandler(p));
    }

    const executor = new RunExecutor({
      runRepository: runRepo,
      failureRepository: failureRepo,
      phaseRepository: phaseRepo,
      events: eventBus,
      registry,
      contextFactory: () => ({
        runId: run.uuid,
        runUuid: run.uuid,
        repoFullName: 'owner/repo',
        issueNumber: run.issueNumber,
        cwd: '/tmp/test-worktree',
        artifacts: artifactStore,
        github: {} as never,
        git: {} as never,
        agent: {} as never,
        events: eventBus,
        now: () => new Date('2026-01-01T00:00:00Z'),
      }),
    });

    await executor.execute({ run, skip: [], presentArtifacts: [] });

    const persistedPhases = phaseRepo.listByRun(run.uuid);
    expect(persistedPhases).toHaveLength(9);
    for (const phase of persistedPhases) {
      expect(phase.status).toBe('passed');
    }

    const updatedRun = runRepo.findByUuid(run.uuid);
    expect(updatedRun?.status).toBe('passed');
  });

  it('skips the compound phase when in skip list', async () => {
    const runRepo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    const failureRepo = new FakeFailureRepository();
    const artifactStore = new FakeArtifactStore();
    const eventBus = new FakeEventBus();

    const run = makeRun();
    runRepo.addRun({ ...run, startCommitSha: 'abc123' });

    const registry = new PhaseHandlerRegistry();
    const phases = [
      'read_issue',
      'plan-design',
      'plan-write',
      'implement',
      'validate',
      'review-fix',
      'compound',
      'create-pr',
      'post-pr-review',
    ];
    for (const p of phases) {
      registry.register(makeHandler(p));
    }

    const executor = new RunExecutor({
      runRepository: runRepo,
      failureRepository: failureRepo,
      phaseRepository: phaseRepo,
      events: eventBus,
      registry,
      contextFactory: () => ({
        runId: run.uuid,
        runUuid: run.uuid,
        repoFullName: 'owner/repo',
        issueNumber: run.issueNumber,
        cwd: '/tmp/test-worktree',
        artifacts: artifactStore,
        github: {} as never,
        git: {} as never,
        agent: {} as never,
        events: eventBus,
        now: () => new Date('2026-01-01T00:00:00Z'),
      }),
    });

    const result = await executor.execute({
      run,
      skip: [makePhaseName('compound')],
      presentArtifacts: [],
    });

    expect(result.run.status).toBe('passed');
    const compoundPhase = result.phases.find((p) => p.phase === 'compound');
    expect(compoundPhase?.status).toBe('skipped');
  });
});
