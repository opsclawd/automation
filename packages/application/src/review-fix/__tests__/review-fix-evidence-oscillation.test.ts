import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import {
  FakeFindingEvidenceInspector,
  makeFindingEvidenceInspector,
} from '../../test-doubles/fake-finding-evidence-inspector.js';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { ReviewFixLoop } from '../review-fix-loop.js';
import type {
  ReviewFixLoopDeps,
  ReviewStepResult,
  FixStepResult,
  RevalidationResult,
  PostFixGateResult,
  FixStepOptions,
  StepContext,
} from '../types.js';

function collectEvents() {
  const events: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  const bus = {
    publish: (_runUuid: string, e: OrchestratorEvent) =>
      events.push({ type: e.type, metadata: (e.metadata as Record<string, unknown>) ?? {} }),
    subscribe: () => () => {},
  };
  return { events, bus };
}

function baseInput() {
  return {
    runId: RunId('run-1'),
    phaseId: PhaseName('whole-pr-review'),
    repoId: 'owner/repo',
    cwd: '/wt',
    maxIterations: 3,
    reviewProfile: AgentProfileName('opencode-frontier'),
    fixProfile: AgentProfileName('pi-qwen-local'),
    fixFallbackProfile: AgentProfileName('opencode-frontier'),
  };
}

function makeDeps(over: Partial<ReviewFixLoopDeps> = {}) {
  let n = 0;
  const { events, bus } = collectEvents();
  const deps: ReviewFixLoopDeps = {
    runPostFixGate: async (): Promise<PostFixGateResult> => ({
      outcome: 'pass',
      output: '',
    }),
    runReview: async (): Promise<ReviewStepResult> => ({
      invocationId: `rev-${++n}`,
      agentOutcome: 'success',
      verdict: 'pass',
    }),
    runFix: async (): Promise<FixStepResult> => ({
      invocationId: `fix-${++n}`,
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
    runRevalidation: async (): Promise<RevalidationResult> => ({
      validationRunId: `val-${++n}`,
      passed: true,
    }),
    loops: new FakeLoopRepository(),
    events: bus,
    now: () => new Date('2026-06-14T00:00:00.000Z'),
    idFactory: () => 'loop-1',
    ...over,
  };
  return { deps, events };
}

const demandA = {
  severity: 'high',
  summary: 'Use a programmatic scenario loop in scenario.test.ts',
  files: ['scenario.test.ts'],
};

const demandB = {
  severity: 'high',
  summary: 'Keep the explicit scenario table in scenario.test.ts',
  files: ['scenario.test.ts'],
};

describe('ReviewFixLoop Evidence Inspection and Oscillation', () => {
  it('drops all unfounded findings, skips the fixer, revalidates, and converges', async () => {
    const fakeInspector = new FakeFindingEvidenceInspector();
    fakeInspector.setNext({ evidenceConfirmed: false, reason: 'unfounded finding' });
    const runFix = vi.fn().mockImplementation(
      async (): Promise<FixStepResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      }),
    );
    const runRevalidation = vi.fn().mockImplementation(
      async (): Promise<RevalidationResult> => ({
        validationRunId: 'val-1',
        passed: true,
      }),
    );

    const { deps, events } = makeDeps({
      findingEvidenceInspector: makeFindingEvidenceInspector(fakeInspector),
      runReview: async () => ({
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [demandA],
      }),
      runFix,
      runRevalidation,
    });

    const result = await new ReviewFixLoop(deps).execute(baseInput());

    expect(runFix).not.toHaveBeenCalled();
    expect(runRevalidation).toHaveBeenCalledTimes(1);
    expect(result.phaseOutcome).toBe('passed');
    expect(result.loopStatus).toBe('converged');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'review.evidence.dropped',
        metadata: expect.objectContaining({ droppedCount: 1, remainingCount: 0 }),
      }),
    );
  });

  it('keeps an all-dropped iteration unresolved when revalidation fails', async () => {
    const fakeInspector = new FakeFindingEvidenceInspector();
    fakeInspector.setNext({ evidenceConfirmed: false, reason: 'unfounded finding' });
    const runFix = vi.fn().mockImplementation(
      async (): Promise<FixStepResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      }),
    );
    const runRevalidation = async (): Promise<RevalidationResult> => ({
      validationRunId: 'val-1',
      passed: false,
      category: 'build',
    });

    const { deps } = makeDeps({
      findingEvidenceInspector: makeFindingEvidenceInspector(fakeInspector),
      runReview: async () => ({
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [demandA],
      }),
      runFix,
      runRevalidation,
    });

    const result = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 1 });

    expect(result.phaseOutcome).toBe('failed');
    expect(result.loopStatus).toBe('exhausted');
    expect(runFix).toHaveBeenCalledTimes(1);
  });

  it('short-circuits to needsHumanReview when unfoundedPingPongLimit is reached', async () => {
    const fakeInspector = new FakeFindingEvidenceInspector();
    fakeInspector.setNext({ evidenceConfirmed: false, reason: 'unfounded finding' });
    const runFix = vi.fn().mockImplementation(
      async (): Promise<FixStepResult> => ({
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_no_fixes_needed',
        rebuttal: 'Finding is invalid because of X',
      }),
    );

    const { deps, events } = makeDeps({
      unfoundedPingPongLimit: 2,
      findingEvidenceInspector: makeFindingEvidenceInspector(fakeInspector),
      runReview: async () => ({
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [demandA],
      }),
      runRevalidation: async () => ({
        validationRunId: 'val-1',
        passed: false,
      }),
      runFix,
    });

    const result = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 5 });

    expect(result.phaseOutcome).toBe('failed');
    expect(result.needsHumanReview).toBe(true);
    expect(result.humanReviewReason).toContain(
      'unfounded finding ping-pong detected across 2 iterations',
    );
    expect(runFix).toHaveBeenCalledTimes(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'review.unfounded_pingpong.detected',
        metadata: expect.objectContaining({ limit: 2, unfoundedCount: 1 }),
      }),
    );
  });

  it('passes only grounded findings to the fixer and records every drop', async () => {
    const artifactStore = new FakeArtifactStore();
    await artifactStore.write({
      runId: 'run-1',
      phaseId: 'whole-pr-review',
      relativePath: 'code-review.md',
      contents: '# Review\n- Grounded finding in real.ts',
    });

    const fakeInspector = new FakeFindingEvidenceInspector();
    fakeInspector.setResultFn((input) => {
      if (input.evidence.path.includes('real.ts')) {
        return { evidenceConfirmed: true, reason: 'file exists' };
      }
      return { evidenceConfirmed: false, reason: 'file missing' };
    });

    const groundedFinding = {
      severity: 'high',
      summary: 'Grounded finding',
      files: ['real.ts'],
    };
    const unfoundedFinding = {
      severity: 'high',
      summary: 'Unfounded finding',
      files: ['missing.ts'],
    };

    let capturedFixOptions: FixStepOptions | undefined;
    const runFix = async (_ctx: StepContext, opts: FixStepOptions): Promise<FixStepResult> => {
      capturedFixOptions = opts;
      return {
        invocationId: 'fix-1',
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
      };
    };

    let reviewCount = 0;
    const { deps, events } = makeDeps({
      artifactStore,
      findingEvidenceInspector: makeFindingEvidenceInspector(fakeInspector),
      runReview: async () => {
        reviewCount++;
        if (reviewCount === 1) {
          return {
            invocationId: 'rev-1',
            agentOutcome: 'success',
            verdict: 'fail',
            offendingFindings: [groundedFinding, unfoundedFinding],
          };
        }
        return {
          invocationId: 'rev-2',
          agentOutcome: 'success',
          verdict: 'pass',
        };
      },
      runFix,
    });

    const result = await new ReviewFixLoop(deps).execute(baseInput());

    expect(result.phaseOutcome).toBe('passed');
    expect(result.loopStatus).toBe('converged');
    expect(capturedFixOptions?.allowedFiles).toEqual(['real.ts']);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'review.evidence.dropped',
        metadata: expect.objectContaining({ droppedCount: 1, remainingCount: 1 }),
      }),
    );
  });

  it('preserves fixer behavior when no evidence inspector is configured', async () => {
    let reviewCalls = 0;
    let fixCalls = 0;
    const { deps } = makeDeps({
      findingEvidenceInspector: undefined,
      runReview: async () => {
        reviewCalls++;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success',
          verdict: reviewCalls === 1 ? 'fail' : 'pass',
          offendingFindings: reviewCalls === 1 ? [demandA] : [],
        };
      },
      runFix: async (): Promise<FixStepResult> => {
        fixCalls++;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
        };
      },
    });

    const result = await new ReviewFixLoop(deps).execute(baseInput());

    expect(fixCalls).toBe(1);
    expect(result.phaseOutcome).toBe('passed');
    expect(result.loopStatus).toBe('converged');
  });

  it('halts A to B to A before the third fix and names both demands', async () => {
    let reviewCalls = 0;
    let fixCalls = 0;

    const { deps, events } = makeDeps({
      runReview: async () => {
        reviewCalls++;
        const finding = reviewCalls % 2 === 1 ? demandA : demandB;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success',
          verdict: 'fail',
          offendingFindings: [finding],
        };
      },
      runFix: async (): Promise<FixStepResult> => {
        fixCalls++;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
        };
      },
    });

    const result = await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 5 });

    expect(fixCalls).toBe(2);
    expect(result.phaseOutcome).toBe('failed');
    expect(result.needsHumanReview).toBe(true);

    const escalation = result as typeof result & { humanReviewReason?: string };
    expect(escalation.humanReviewReason).toContain(demandA.summary);
    expect(escalation.humanReviewReason).toContain(demandB.summary);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'review.oscillation.detected',
        metadata: expect.objectContaining({
          demandA: expect.stringContaining(demandA.summary),
          demandB: expect.stringContaining(demandB.summary),
        }),
      }),
    );
  });

  it.each([
    {
      name: 'A -> A -> A (persistent)',
      findingsSequence: [[demandA], [demandA], [demandA]],
    },
    {
      name: 'A -> B -> C (unrelated)',
      findingsSequence: [
        [demandA],
        [demandB],
        [
          {
            severity: 'high',
            summary: 'Refactor scenario helper in scenario.test.ts',
            files: ['scenario.test.ts'],
          },
        ],
      ],
    },
  ])(
    'does not classify persistent or unrelated findings as oscillation ($name)',
    async ({ findingsSequence }) => {
      let reviewCall = 0;
      const { deps, events } = makeDeps({
        runReview: async () => {
          const findings = findingsSequence[reviewCall] ?? [];
          reviewCall++;
          return {
            invocationId: `rev-${reviewCall}`,
            agentOutcome: 'success',
            verdict: 'fail',
            offendingFindings: findings,
          };
        },
        runFix: async (): Promise<FixStepResult> => ({
          invocationId: 'fix',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
        }),
      });

      await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });

      const oscillationEvents = events.filter((e) => e.type === 'review.oscillation.detected');
      expect(oscillationEvents).toHaveLength(0);
    },
  );

  it('falls back to reading code-review.md from input.cwd when artifactStore is absent', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-test-'));
    const codeReviewPath = path.join(tmpDir, 'code-review.md');
    await fs.writeFile(codeReviewPath, '# Review\n- Grounded finding in real.ts');

    try {
      const fakeInspector = new FakeFindingEvidenceInspector();
      fakeInspector.setResultFn((input) => {
        if (input.evidence.path.includes('real.ts')) {
          return { evidenceConfirmed: true, reason: 'file exists' };
        }
        return { evidenceConfirmed: false, reason: 'file missing' };
      });

      const groundedFinding = {
        severity: 'high',
        summary: 'Grounded finding',
        files: ['real.ts'],
      };

      let reviewCount = 0;
      const { deps, events } = makeDeps({
        artifactStore: undefined,
        findingEvidenceInspector: makeFindingEvidenceInspector(fakeInspector),
        runReview: async () => {
          reviewCount++;
          if (reviewCount === 1) {
            return {
              invocationId: 'rev-1',
              agentOutcome: 'success',
              verdict: 'fail',
              offendingFindings: [groundedFinding],
            };
          }
          return {
            invocationId: 'rev-2',
            agentOutcome: 'success',
            verdict: 'pass',
          };
        },
        runFix: async (): Promise<FixStepResult> => ({
          invocationId: 'fix-1',
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
        }),
      });

      const result = await new ReviewFixLoop(deps).execute({
        ...baseInput(),
        cwd: tmpDir,
      });

      expect(result.phaseOutcome).toBe('passed');
      const evidenceDroppedEvent = events.find((e) => e.type === 'review.evidence.dropped');
      expect(evidenceDroppedEvent).toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
