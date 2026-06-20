import { describe, it, expect } from 'vitest';
import { RunExecutor } from '../run-executor.js';
import { PhaseHandlerRegistry } from '../phase-handler-registry.js';
import type { PhaseHandler, PhaseHandlerContext } from '../../phases/handler.js';
import type { Run, Failure } from '@ai-sdlc/domain';
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

function makeFailure(overrides?: Partial<Failure>): Failure {
  return {
    runUuid: 'test-uuid',
    kind: 'command_failed',
    message: 'simulated failure',
    canRetry: false,
    suggestedAction: 'Check logs',
    artifacts: [],
    detectedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
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

  it('marks run as failed when a handler returns failed outcome', async () => {
    const runRepo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    const failureRepo = new FakeFailureRepository();
    const artifactStore = new FakeArtifactStore();
    const eventBus = new FakeEventBus();

    const run = makeRun();
    runRepo.addRun({ ...run, startCommitSha: 'abc123' });

    const registry = new PhaseHandlerRegistry();
    registry.register({
      phase: makePhaseName('read_issue'),
      run: async () => ({ outcome: 'failed', failure: makeFailure() }),
    });

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

    const result = await executor.execute({ run, skip: [], presentArtifacts: [] });

    expect(result.run.status).toBe('failed');
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.status).toBe('failed');
    expect(result.phases[0]!.failure).toBeDefined();

    const persistedRun = runRepo.findByUuid(run.uuid);
    expect(persistedRun?.status).toBe('failed');

    const persistedFailure = failureRepo.findLatestByRun(run.uuid);
    expect(persistedFailure).toBeDefined();
    expect(persistedFailure!.kind).toBe('command_failed');
  });

  it('pauses run when a handler returns blocked outcome', async () => {
    const runRepo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    const failureRepo = new FakeFailureRepository();
    const artifactStore = new FakeArtifactStore();
    const eventBus = new FakeEventBus();

    const run = makeRun();
    runRepo.addRun({ ...run, startCommitSha: 'abc123' });

    const registry = new PhaseHandlerRegistry();
    registry.register({
      phase: makePhaseName('read_issue'),
      run: async () => ({ outcome: 'blocked', failure: makeFailure({ kind: 'agent_blocked' }) }),
    });

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

    const result = await executor.execute({ run, skip: [], presentArtifacts: [] });

    expect(result.run.status).toBe('blocked');
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.status).toBe('blocked');

    const persistedRun = runRepo.findByUuid(run.uuid);
    expect(persistedRun?.status).toBe('blocked');
  });

  it('pauses run when a handler returns resting outcome', async () => {
    const runRepo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    const failureRepo = new FakeFailureRepository();
    const artifactStore = new FakeArtifactStore();
    const eventBus = new FakeEventBus();

    const run = makeRun();
    runRepo.addRun({ ...run, startCommitSha: 'abc123' });

    const registry = new PhaseHandlerRegistry();
    registry.register({
      phase: makePhaseName('read_issue'),
      run: async () => ({ outcome: 'resting' }),
    });

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

    const result = await executor.execute({ run, skip: [], presentArtifacts: [] });

    // Resting is a phase-level pause — the run status stays as 'running',
    // but currentPhase is cleared and no further phases execute
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.status).toBe('resting');
    expect(result.run.currentPhase).toBeUndefined();
  });

  it('marks run as failed when a handler throws an exception', async () => {
    const runRepo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    const failureRepo = new FakeFailureRepository();
    const artifactStore = new FakeArtifactStore();
    const eventBus = new FakeEventBus();

    const run = makeRun();
    runRepo.addRun({ ...run, startCommitSha: 'abc123' });

    const registry = new PhaseHandlerRegistry();
    registry.register({
      phase: makePhaseName('read_issue'),
      run: async () => {
        throw new Error('handler crash');
      },
    });

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

    const result = await executor.execute({ run, skip: [], presentArtifacts: [] });

    expect(result.run.status).toBe('failed');
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]!.status).toBe('failed');
  });

  it('resumes correctly when completedPhases are present', async () => {
    const runRepo = new FakeRunRepository();
    const phaseRepo = new FakePhaseRepository();
    const failureRepo = new FakeFailureRepository();
    const artifactStore = new FakeArtifactStore();
    const eventBus = new FakeEventBus();

    // Write the artifact that read_issue produces so the resume check passes
    await artifactStore.write({ runId: 'test-uuid', relativePath: 'issue.md', contents: 'test' });
    await artifactStore.write({
      runId: 'test-uuid',
      relativePath: 'issue-comments.md',
      contents: 'test',
    });

    const run = makeRun({ completedPhases: ['read_issue'] });
    runRepo.addRun({ ...run, startCommitSha: 'abc123' });

    const registry = new PhaseHandlerRegistry();
    for (const p of [
      'read_issue',
      'plan-design',
      'plan-write',
      'implement',
      'validate',
      'review-fix',
      'compound',
      'create-pr',
      'post-pr-review',
    ]) {
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

    const result = await executor.execute({ run, skip: [], presentArtifacts: [] });

    expect(result.run.status).toBe('passed');
    expect(result.phases).toHaveLength(9);
    expect(result.phases[0]!.status).toBe('passed');
    expect(result.phases[0]!.phase).toBe(makePhaseName('read_issue'));
    expect(result.phases[1]!.status).toBe('passed');
    expect(result.phases[1]!.phase).toBe(makePhaseName('plan-design'));
  });
});
