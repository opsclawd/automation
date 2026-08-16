import { describe, expect, it, vi } from 'vitest';
import { AgentProfileName, PhaseName, RunId } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ImplementStepLoop } from '../implement-step-loop.js';
import type {
  ImplementStepLoopDeps,
  ImplementResult,
  QualityReviewResult,
  SpecReviewResult,
  StepLoopContext,
  TypecheckResult,
  FixResult,
  ImplementFixStepOptions,
  ImplementStepHistoryPort,
  ImplementStepHistoryEntry,
  ArbiterResult,
} from '../types.js';
import type { EventBusPort } from '../../ports/event-bus-port.js';

function collectEvents() {
  const events: OrchestratorEvent[] = [];
  const bus: EventBusPort = {
    publish: (_runUuid: string, e: OrchestratorEvent) => events.push(e),
    subscribe: () => () => {},
  };
  return { events, bus };
}

function makeInMemoryImplementHistory(): {
  port: ImplementStepHistoryPort;
  entries: ImplementStepHistoryEntry[];
} {
  const entries: ImplementStepHistoryEntry[] = [];
  return {
    entries,
    port: {
      async read(_ctx: StepLoopContext) {
        return [...entries];
      },
      async append(_ctx: StepLoopContext, entry: ImplementStepHistoryEntry) {
        entries.push(entry);
      },
      format(history: ImplementStepHistoryEntry[]) {
        return history
          .map(
            (e) =>
              `- iteration ${e.iteration} outcome=${e.outcome} fix=${e.fix?.verdict ?? 'none'}`,
          )
          .join('\n');
      },
    },
  };
}

function baseInput() {
  return {
    runId: RunId('run-1'),
    phaseId: PhaseName('implement'),
    repoId: 'owner/repo',
    cwd: '/wt',
    stepIndex: 1,
    stepTitle: 'Add physical telemetry capture',
    maxIterations: 3,
    manifest: {
      version: 2 as const,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Add physical telemetry capture',
          expected_files: ['certification/transition-soak/result.json'],
        },
      ],
    },
    planMd: '# Plan',
  };
}

const fabricatedQualityResult = {
  invocationId: 'quality-fabricated-1',
  agentOutcome: 'success',
  verdict: 'fabricated',
  findings: [
    {
      severity: 'P0',
      summary: 'Claimed RTX 4090 soak never ran',
      file: 'certification/transition-soak/result.json',
    },
  ],
} as unknown as QualityReviewResult;

function createHarness() {
  const { events, bus } = collectEvents();
  const history = makeInMemoryImplementHistory();
  const loops = new FakeLoopRepository();

  const runImplement = vi.fn(
    async (): Promise<ImplementResult> => ({
      invocationId: 'impl-1',
      agentOutcome: 'success',
    }),
  );

  const runTypecheck = vi.fn(
    async (): Promise<TypecheckResult> => ({
      outcome: 'pass',
      output: '',
    }),
  );

  const runSpecReview = vi.fn(
    async (): Promise<SpecReviewResult> => ({
      invocationId: 'spec-1',
      agentOutcome: 'success',
      verdict: 'pass',
    }),
  );

  const runQualityReview = vi.fn(async (): Promise<QualityReviewResult> => fabricatedQualityResult);

  const runFix = vi.fn(
    async (_ctx: StepLoopContext, _opts: ImplementFixStepOptions): Promise<FixResult> => ({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
  );

  const runArbiter = vi.fn(
    async (): Promise<ArbiterResult> => ({
      outcome: 'finding_valid',
      evidence: 'evidence',
      rationale: 'rationale',
    }),
  );

  const runFinalReviewArbiter = vi.fn(
    async (): Promise<ArbiterResult> => ({
      outcome: 'finding_valid',
      evidence: 'evidence',
      rationale: 'rationale',
    }),
  );

  const deps: ImplementStepLoopDeps = {
    runImplement,
    runTypecheck,
    runSpecReview,
    runQualityReview,
    runFix,
    runArbiter,
    runFinalReviewArbiter,
    loopHistory: history.port,
    loops,
    events: bus,
    implementProfile: AgentProfileName('opencode-frontier'),
    fixProfile: AgentProfileName('pi-qwen-local'),
    fixFallbackProfile: AgentProfileName('opencode-frontier'),
    now: () => new Date('2026-08-16T00:00:00.000Z'),
    idFactory: () => 'loop-1',
  };

  return {
    deps,
    events,
    history,
    loops,
    spies: {
      runImplement,
      runTypecheck,
      runSpecReview,
      runQualityReview,
      runFix,
      runArbiter,
      runFinalReviewArbiter,
    },
  };
}

describe('implement-step loop fabricated evidence transition', () => {
  it('fails the Step immediately without invoking the fixer when quality review reports fabricated evidence', async () => {
    const harness = createHarness();
    const loop = new ImplementStepLoop(harness.deps);
    const result = await loop.execute(baseInput());

    expect(result.outcome).toBe('failed');
    expect(result.failureMessage).toBe(
      'Step 1 (Add physical telemetry capture) failed because quality review determined that the implementation fabricated evidence of external physical execution.',
    );
    expect(result.loop.status).toBe('failed');
    expect(result.loop.iterations[0]?.outcome).toBe('failed');
    expect(harness.spies.runFix).not.toHaveBeenCalled();
  });

  it('does not retry arbitrate or fix a fabricated quality-review verdict', async () => {
    const harness = createHarness();
    const loop = new ImplementStepLoop(harness.deps);
    await loop.execute(baseInput());

    expect(harness.spies.runQualityReview).toHaveBeenCalledTimes(1);
    expect(harness.spies.runFix).not.toHaveBeenCalled();
    expect(harness.spies.runArbiter).not.toHaveBeenCalled();
    expect(harness.spies.runFinalReviewArbiter).not.toHaveBeenCalled();
  });

  it('records fabricated evidence in failed history and the terminal error event', async () => {
    const harness = createHarness();
    const loop = new ImplementStepLoop(harness.deps);
    await loop.execute(baseInput());

    const fabricatedEvent = harness.events.find((e) => e.type === 'step.quality-review.fabricated');
    expect(fabricatedEvent).toBeDefined();
    expect(fabricatedEvent?.level).toBe('error');
    expect(fabricatedEvent?.message).toContain('fabricated evidence');
    expect(fabricatedEvent?.metadata).toMatchObject({
      index: 1,
      iterationIndex: 1,
      invocationId: 'quality-fabricated-1',
      findings: [
        {
          severity: 'P0',
          summary: 'Claimed RTX 4090 soak never ran',
          file: 'certification/transition-soak/result.json',
        },
      ],
    });

    expect(harness.history.entries).toHaveLength(1);
    expect(harness.history.entries[0]).toMatchObject({
      iteration: 1,
      outcome: 'failed',
      qualityReview: {
        invocationId: 'quality-fabricated-1',
        verdict: 'fabricated',
        findings: [
          {
            severity: 'P0',
            summary: 'Claimed RTX 4090 soak never ran',
            file: 'certification/transition-soak/result.json',
          },
        ],
      },
    });
  });
});
