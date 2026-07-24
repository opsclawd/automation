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
import type {
  RunRepositoryPort,
  FailureRepositoryPort,
  EventBusPort,
  LoggerPort,
} from '../../ports.js';
import type { PhaseRepositoryPort } from '../../ports/phase-repository-port.js';
import { RunExecutor } from '../run-executor.js';
import type { ExecuteRunInput } from '../run-executor.js';
import { FakePhaseRepository } from '../../test-doubles/fake-phase-repository.js';

const ALL_PHASES = [
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
        return { outcome: 'failed', failure: makeFailure(phase) };
      }
      if (outcome === 'blocked') {
        return { outcome: 'blocked', failure: makeFailure(phase, 'agent_blocked') };
      }
      if (outcome === 'needs_human_review') {
        return { outcome: 'needs_human_review', failure: makeFailure(phase, 'agent_incomplete') };
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
  contextFactory?: (run: Run) => PhaseHandlerContext;
  logger?: LoggerPort;
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
          hydrateWorktree: async () => {},
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
    logger: overrides?.logger,
  };
}

function makeSpyLogger(): LoggerPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    debug: vi.fn((msg: string) => {
      calls.push(`debug:${msg}`);
    }),
    info: vi.fn((msg: string) => {
      calls.push(`info:${msg}`);
    }),
    warn: vi.fn((msg: string) => {
      calls.push(`warn:${msg}`);
    }),
    error: vi.fn((msg: string) => {
      calls.push(`error:${msg}`);
    }),
    calls,
  };
}

describe('RunExecutor terminal persistence', () => {
  async function runWithLogger(outcome: 'passed' | 'failed' | 'blocked' | 'needs_human_review') {
    const logger = makeSpyLogger();
    const registry = new PhaseHandlerRegistry();

    if (outcome === 'passed') {
      registerAllPassed(registry);
    } else if (outcome === 'failed') {
      registry.register(makeStubHandler('read_issue', 'failed'));
    } else if (outcome === 'blocked') {
      registry.register(makeStubHandler('read_issue', 'blocked'));
    } else {
      registry.register(makeStubHandler('read_issue', 'needs_human_review'));
    }

    const deps = makeDeps({ registry, logger });
    const executor = new RunExecutor(deps);
    const run = makeRun();
    const input: ExecuteRunInput = { run, skip: [], presentArtifacts: [] };
    const result = await executor.execute(input);

    return { logger, result };
  }

  it('logs before and after passed failed blocked and needs_human_review persistence', async () => {
    for (const outcome of ['passed', 'failed', 'blocked', 'needs_human_review'] as const) {
      const { logger, result } = await runWithLogger(outcome);
      expect(result.run.status).toBe(outcome);

      const calls = logger.calls;
      const updateCalls = calls.filter((c) => c.includes('terminal status write'));

      const startIdx = updateCalls.findIndex((c) => c.includes('starting'));
      const completeIdx = updateCalls.findIndex((c) => c.includes('completed'));

      (expect(startIdx).toBeGreaterThanOrEqual(0), `Expected start marker for ${outcome}`);
      (expect(completeIdx).toBeGreaterThanOrEqual(0), `Expected complete marker for ${outcome}`);
      (expect(completeIdx).toBeGreaterThan(startIdx),
        `Complete should come after start for ${outcome}`);
    }
  });

  describe('does not log completion when a terminal write throws', () => {
    it('does not emit completion marker when runRepository.update throws', async () => {
      const logger = makeSpyLogger();
      const registry = new PhaseHandlerRegistry();
      registry.register(makeStubHandler('read_issue', 'failed'));

      const throwingUpdate = vi.fn((_uuid: string, patch: Record<string, unknown>) => {
        if ('status' in patch && patch.status === 'failed') {
          throw new Error('DB write failed');
        }
        return undefined;
      });

      const deps = makeDeps({
        registry,
        logger,
        runRepository: {
          update: throwingUpdate,
          findByUuid: vi.fn().mockReturnValue(undefined),
        },
      });
      const executor = new RunExecutor(deps);
      const run = makeRun();
      const input: ExecuteRunInput = { run, skip: [], presentArtifacts: [] };

      await expect(executor.execute(input)).rejects.toThrow('DB write failed');

      const calls = logger.calls;
      const updateCalls = calls.filter((c) => c.includes('terminal status write'));
      const hasStart = updateCalls.some((c) => c.includes('starting'));
      const hasComplete = updateCalls.some((c) => c.includes('completed'));

      expect(hasStart).toBe(true);
      expect(hasComplete).toBe(false);
    });
  });

  describe('signal cleanup logs before and after a successful status write', () => {
    it('signal cleanup logs before and after a successful status write', async () => {
      const logger = makeSpyLogger();
      const registry = new PhaseHandlerRegistry();
      registry.register(makeStubHandler('read_issue', 'passed'));
      registerAllPassed(registry);

      const updateSpy = vi.fn();
      const deps = makeDeps({
        registry,
        logger,
        runRepository: {
          update: updateSpy,
          findByUuid: vi.fn().mockReturnValue(undefined),
        },
      });
      const executor = new RunExecutor(deps);
      const run = makeRun();
      const input: ExecuteRunInput = { run, skip: [], presentArtifacts: [] };

      await executor.execute(input);

      const calls = logger.calls;
      const updateCalls = calls.filter((c) => c.includes('terminal status write'));

      expect(updateCalls.length).toBeGreaterThanOrEqual(2);

      const startIdx = calls.findIndex((c) => c.includes('terminal status write starting'));
      const completeIdx = calls.findIndex((c) => c.includes('terminal status write completed'));

      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(completeIdx).toBeGreaterThan(startIdx);
    });
  });
});
