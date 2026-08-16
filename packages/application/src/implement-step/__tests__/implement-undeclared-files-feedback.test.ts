import { describe, it, expect, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ImplementStepLoop } from '../implement-step-loop.js';
import type {
  ImplementStepLoopDeps,
  ImplementResult,
  ImplementStepOptions,
  TypecheckResult,
  StepLoopContext,
  SpecReviewResult,
  QualityReviewResult,
  FixResult,
} from '../types.js';

function createHarness() {
  const recordedImplementOpts: Array<ImplementStepOptions | undefined> = [];

  let n = 0;
  const deps: ImplementStepLoopDeps = {
    runImplement: vi.fn(
      async (_ctx: StepLoopContext, opts?: ImplementStepOptions): Promise<ImplementResult> => {
        recordedImplementOpts.push(opts);
        return {
          invocationId: `impl-${++n}`,
          agentOutcome: 'success',
        };
      },
    ),
    runTypecheck: async (): Promise<TypecheckResult> => ({
      outcome: 'pass',
      output: '',
    }),
    runSpecReview: async (): Promise<SpecReviewResult> => ({
      invocationId: 'spec-1',
      agentOutcome: 'success',
      verdict: 'pass',
    }),
    runQualityReview: async (): Promise<QualityReviewResult> => ({
      invocationId: 'qual-1',
      agentOutcome: 'success',
      verdict: 'pass',
    }),
    runFix: async (): Promise<FixResult> => ({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
    implementProfile: AgentProfileName('test-profile'),
    fixProfile: AgentProfileName('fix-profile'),
    loops: new FakeLoopRepository(),
    events: {
      publish: () => {},
      subscribe: () => () => {},
    },
    now: () => new Date('2026-06-16T00:00:00Z'),
    idFactory: (() => {
      let id = 0;
      return () => `id-${++id}`;
    })(),
  };

  const loop = new ImplementStepLoop(deps);
  return { loop, recordedImplementOpts, runImplement: deps.runImplement };
}

describe('ImplementStepLoop undeclared files feedback forwarding', () => {
  it('forwards only current boundary violations to the next implement invocation', async () => {
    const { loop, recordedImplementOpts } = createHarness();

    await loop.execute({
      runId: RunId('run-1'),
      phaseId: PhaseName('implement'),
      repoId: 'acme/widgets',
      cwd: '/tmp/wt',
      stepIndex: 1,
      stepTitle: 'Task 1: boundary forwarding',
      maxIterations: 1,
      manifest: { tasks: [] },
      planMd: '',
      priorAttemptMissingFiles: ['src/missing.ts'],
      priorAttemptUndeclaredFiles: ['src/unrelated.ts'],
      priorAttemptModifiedReferenceFiles: ['src/ref.ts'],
    });

    expect(recordedImplementOpts).toHaveLength(1);
    expect(recordedImplementOpts[0]).toEqual({
      priorAttemptMissingFiles: ['src/missing.ts'],
      priorAttemptUndeclaredFiles: ['src/unrelated.ts'],
      priorAttemptModifiedReferenceFiles: ['src/ref.ts'],
    });
  });

  it('omits implement options when boundary feedback lists are absent', async () => {
    const { loop, recordedImplementOpts } = createHarness();

    await loop.execute({
      runId: RunId('run-1'),
      phaseId: PhaseName('implement'),
      repoId: 'acme/widgets',
      cwd: '/tmp/wt',
      stepIndex: 1,
      stepTitle: 'Task 1: no feedback',
      maxIterations: 1,
      manifest: { tasks: [] },
      planMd: '',
    });

    expect(recordedImplementOpts).toHaveLength(1);
    expect(recordedImplementOpts[0]).toBeUndefined();
  });
});
