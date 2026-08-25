import { describe, it, expect } from 'vitest';
import { RunId, PhaseName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { PlanReviewLoop } from '../plan-review-loop.js';
import type {
  PlanReviewLoopDeps,
  PlanReviewResult,
  PlanFixResult,
  PlanReviewContext,
  PlanReviewFinding,
  PlanReviewSnapshot,
  PlanReviewArbiterResult,
} from '../types.js';
import type { ArbiterResult } from '../../implement-step/types.js';
import type { EventBusPort } from '../../ports/event-bus-port.js';

interface ValidationFailureResult extends PlanReviewResult {
  validationError?: string;
}

const failedReview: ValidationFailureResult = {
  invocationId: 'review-invalid-1',
  agentOutcome: 'failed',
  validationError:
    'pass verdict must not include unresolved blocking findings (missing disposition or still_open)',
};

function arbiterResult(
  result: ArbiterResult,
  groundingSources = {
    planExcerpt: 'The defect is real and not addressed by prior fixes.',
    manifestExcerpt: '{"version":2}',
  },
): PlanReviewArbiterResult {
  return { ...result, groundingSources };
}

function collectEvents() {
  const events: Array<{
    type: string;
    level: string;
    message: string;
    metadata: Record<string, unknown>;
  }> = [];
  const bus: EventBusPort = {
    publish: (_runUuid: string, e: OrchestratorEvent) =>
      events.push({ type: e.type, level: e.level, message: e.message, metadata: e.metadata }),
    subscribe: () => () => {},
  };
  return { events, bus };
}

function baseInput() {
  return {
    runId: RunId('run-1'),
    phaseId: PhaseName('plan-review'),
    repoId: 'owner/repo',
    cwd: '/wt',
    maxIterations: 3,
  };
}

function groundedP1Findings(citation = 'plan.md:42'): ReadonlyArray<PlanReviewFinding> {
  return [
    {
      severity: 'P1' as const,
      citation,
      failureScenario: 'Missing transition handler',
      evidence: 'grounded' as const,
    },
  ];
}

function makeDeps(over: Partial<PlanReviewLoopDeps>): {
  deps: PlanReviewLoopDeps;
  events: ReturnType<typeof collectEvents>['events'];
} {
  let n = 0;
  const { bus, events } = collectEvents();
  const fakeGit = new FakeGitPort();
  fakeGit.headByCwd.set('/wt', 'test-head-sha');
  fakeGit.headCommitSha = async (cwd: string) => {
    return fakeGit.headByCwd.get(cwd) ?? 'test-head-sha';
  };
  const captureSnapshot = async (
    _ctx: PlanReviewContext,
  ): Promise<PlanReviewSnapshot | undefined> => ({
    planMdDigest: 'test-snapshot-digest',
    planMdPath: '/wt/plan.md',
    capturedAt: '2026-07-08T00:00:00.000Z',
  });
  const deps: PlanReviewLoopDeps = {
    git: fakeGit,
    readPlanMd: async () => 'plan.md before-fix text\n',
    runReview: async () => ({
      invocationId: `rev-${++n}`,
      agentOutcome: 'success' as const,
      verdict: 'pass' as const,
    }),
    runFix: async () => ({
      invocationId: `fix-${++n}`,
      agentOutcome: 'success' as const,
      verdict: 'done_with_fixes' as const,
    }),
    checkDeterministicPlan: async () => ({
      diagnostic: null,
      signatureBlastRadiusFailures: [],
    }),
    computeLastFixDiffCitations: () => [],
    runArbiter: undefined,
    loops: new FakeLoopRepository(),
    events: bus,
    now: () => new Date('2026-07-08T00:00:00.000Z'),
    idFactory: () => 'loop-1',
    captureSnapshot,
    ...over,
  };
  return { deps, events };
}

describe('reviewer output validation retry regression coverage', () => {
  it('threads output validation failure into the primary reviewer retry and accepts a valid second response', async () => {
    let reviewCalls = 0;
    let capturedValidationError: unknown;

    const { deps } = makeDeps({
      reviewerMaxRetries: 2,
      runReview: async (ctx: PlanReviewContext): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          return failedReview;
        }
        capturedValidationError = ctx.metadata?.validationError;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success',
          verdict: 'pass',
          findings: [],
        };
      },
    });

    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.status).toBe('converged');
    expect(reviewCalls).toBe(2);
    expect(capturedValidationError).toBe(failedReview.validationError);
  });

  it('threads output validation failure into the post-reopen verification retry', async () => {
    let reviewCalls = 0;
    let fixCalls = 0;
    let capturedValidationError: unknown;

    const { deps } = makeDeps({
      reviewerMaxRetries: 2,
      runReview: async (ctx: PlanReviewContext): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success',
            verdict: 'p1_found',
            findings: groundedP1Findings(),
          };
        } else if (reviewCalls === 2) {
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success',
            verdict: 'pass',
            findings: [],
          };
        } else if (reviewCalls === 3) {
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success',
            verdict: 'p1_found',
            findings: groundedP1Findings(),
          };
        } else if (reviewCalls === 4) {
          return failedReview;
        }
        capturedValidationError = ctx.metadata?.validationError;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success',
          verdict: 'pass',
          findings: [],
        };
      },
      runFix: async (): Promise<PlanFixResult> => {
        fixCalls += 1;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
        };
      },
    });

    const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 2 });
    expect(out.outcome).toBe('success');
    expect(out.loop.status).toBe('converged');
    expect(reviewCalls).toBe(5);
    expect(fixCalls).toBe(2);
    expect(capturedValidationError).toBe(failedReview.validationError);
  });

  it('threads output validation failure into the final review retry', async () => {
    let reviewCalls = 0;
    let fixCalls = 0;
    let capturedValidationError: unknown;

    const { deps } = makeDeps({
      reviewerMaxRetries: 2,
      runReview: async (ctx: PlanReviewContext): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success',
            verdict: 'p1_found',
            findings: groundedP1Findings(),
          };
        } else if (reviewCalls === 2) {
          return failedReview;
        }
        capturedValidationError = ctx.metadata?.validationError;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success',
          verdict: 'pass',
          findings: [],
        };
      },
      runFix: async (): Promise<PlanFixResult> => {
        fixCalls += 1;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
        };
      },
    });

    const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
    expect(out.outcome).toBe('success');
    expect(out.loop.status).toBe('converged');
    expect(reviewCalls).toBe(3);
    expect(fixCalls).toBe(1);
    expect(capturedValidationError).toBe(failedReview.validationError);
  });

  it('threads output validation failure into the confirmation re-review retry', async () => {
    let reviewCalls = 0;
    let fixCalls = 0;
    let capturedValidationError: unknown;

    const { deps } = makeDeps({
      reviewerMaxRetries: 2,
      runReview: async (ctx: PlanReviewContext): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success',
            verdict: 'p1_found',
            findings: groundedP1Findings(),
          };
        } else if (reviewCalls === 2) {
          return {
            invocationId: `rev-${reviewCalls}`,
            agentOutcome: 'success',
            verdict: 'p1_found',
            findings: groundedP1Findings(),
          };
        } else if (reviewCalls === 3) {
          return failedReview;
        }
        capturedValidationError = ctx.metadata?.validationError;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success',
          verdict: 'pass',
          findings: [],
        };
      },
      runFix: async (): Promise<PlanFixResult> => {
        fixCalls += 1;
        return {
          invocationId: `fix-${fixCalls}`,
          agentOutcome: 'success',
          verdict: 'done_with_fixes',
        };
      },
      runFinalReviewArbiter: async (): Promise<PlanReviewArbiterResult> =>
        arbiterResult({
          outcome: 'finding_valid',
          evidence: '<quote>The defect is real and not addressed by prior fixes.</quote>',
          rationale: 'fix the defect',
        }),
    });

    const out = await new PlanReviewLoop(deps).execute({ ...baseInput(), maxIterations: 1 });
    expect(out.outcome).toBe('success');
    expect(out.loop.status).toBe('converged');
    expect(reviewCalls).toBe(4);
    expect(fixCalls).toBe(2);
    expect(capturedValidationError).toBe(failedReview.validationError);
  });

  it('does not add validation feedback to an invocation-level retry', async () => {
    let reviewCalls = 0;
    let capturedValidationError: unknown;

    const { deps } = makeDeps({
      reviewerMaxRetries: 2,
      runReview: async (ctx: PlanReviewContext): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          return {
            invocationId: 'rev-fail',
            agentOutcome: 'failed',
          };
        }
        capturedValidationError = ctx.metadata?.validationError;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success',
          verdict: 'pass',
          findings: [],
        };
      },
    });

    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('success');
    expect(out.loop.status).toBe('converged');
    expect(reviewCalls).toBe(2);
    expect(capturedValidationError).toBeUndefined();
  });

  it('still stops immediately after duplicate_retry_suppressed', async () => {
    let reviewCalls = 0;

    const { deps } = makeDeps({
      reviewerMaxRetries: 2,
      runReview: async (): Promise<PlanReviewResult> => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'duplicate_retry_suppressed',
        };
      },
    });

    const out = await new PlanReviewLoop(deps).execute(baseInput());
    expect(out.outcome).toBe('needs_human_review');
    expect(reviewCalls).toBe(1);
  });
});
