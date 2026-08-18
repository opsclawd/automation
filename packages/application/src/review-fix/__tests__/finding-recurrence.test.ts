import { describe, it, expect } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type { EventBusPort } from '../../ports/event-bus-port.js';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ReviewFixLoop } from '../review-fix-loop.js';
import type {
  ReviewFixLoopDeps,
  ReviewFixLoopInput,
  ReviewStepResult,
  FixStepResult,
  StepContext,
  FixStepOptions,
  ReviewStepOptions,
} from '../types.js';

function baseInput(overrides?: Partial<ReviewFixLoopInput>): ReviewFixLoopInput {
  return {
    runId: RunId('run-recurrence-proof'),
    phaseId: PhaseName('review-fix'),
    repoId: 'owner/repo',
    cwd: '/wt',
    maxIterations: 3,
    reviewProfile: AgentProfileName('reviewer'),
    fixProfile: AgentProfileName('fixer'),
    baselineCommitSha: 'base-sha-123',
    manifest: {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['src/config.ts'],
        },
      ],
    },
    ...overrides,
  };
}

function collectEvents() {
  const events: Array<{ type: string; metadata?: Record<string, unknown> }> = [];
  const bus: EventBusPort = {
    publish: (_runUuid: string, e: OrchestratorEvent) =>
      events.push({ type: e.type, metadata: e.metadata as Record<string, unknown> | undefined }),
    subscribe: () => () => {},
  };
  return { events, bus };
}

describe('ReviewFixLoop finding recurrence', () => {
  it('escalates a recurring raw finding at iteration N+1 before another fix attempt', async () => {
    const { events, bus } = collectEvents();
    const git = new FakeGitPort();
    const cwd = '/wt';
    const head1 = 'head-sha-1';
    const head2 = 'head-sha-2';

    git.headByCwd.set(cwd, head1);
    git.changedFiles = async (_cwd: string, _base: string, _head?: string) => ['src/config.ts'];

    const reviewCalls: Array<{ ctx: StepContext; opts?: ReviewStepOptions }> = [];
    const runReview = async (
      ctx: StepContext,
      opts?: ReviewStepOptions,
    ): Promise<ReviewStepResult> => {
      reviewCalls.push({ ctx, opts });
      return {
        invocationId: `rev-${reviewCalls.length}`,
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          {
            severity: 'high',
            summary: 'Missing config validation',
            files: ['src/config.ts'],
          },
        ],
      };
    };

    const fixCalls: Array<{ ctx: StepContext; opts: FixStepOptions }> = [];
    const runFix = async (ctx: StepContext, opts: FixStepOptions): Promise<FixStepResult> => {
      fixCalls.push({ ctx, opts });
      const currentHead = await git.headCommitSha(cwd);
      const nextHead = currentHead === head1 ? head2 : `head-sha-${fixCalls.length + 2}`;
      git.headByCwd.set(cwd, nextHead);
      return {
        invocationId: `fix-${fixCalls.length}`,
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: currentHead,
      };
    };

    const deps: ReviewFixLoopDeps = {
      runPostFixGate: async () => ({ outcome: 'pass', output: '' }),
      runReview,
      runFix,
      runRevalidation: async () => ({ validationRunId: 'val-1', passed: true }),
      loops: new FakeLoopRepository(),
      events: bus,
      now: () => new Date('2026-01-01T00:00:00Z'),
      idFactory: () => 'loop-1',
      cleanArtifacts: async () => {},
      git,
    };

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute(baseInput());

    expect(reviewCalls).toHaveLength(2);
    expect(fixCalls).toHaveLength(1);
    expect(result.phaseOutcome).toBe('failed');
    expect(result.needsHumanReview).toBe(true);
    expect(events.some((e) => e.type === 'loop.exhausted.finding_recurrence')).toBe(true);
  });

  it('carries prior fixChangedFiles and resolvedInIteration across the iteration boundary', async () => {
    const { events, bus } = collectEvents();
    const git = new FakeGitPort();
    const cwd = '/wt';
    const head1 = 'head-sha-1';
    const head2 = 'head-sha-2';

    git.headByCwd.set(cwd, head1);
    git.changedFiles = async (_cwd: string, _base: string, _head?: string) => ['src/config.ts'];

    let reviewCount = 0;
    const runReview = async (
      _ctx: StepContext,
      _opts?: ReviewStepOptions,
    ): Promise<ReviewStepResult> => {
      reviewCount++;
      return {
        invocationId: `rev-${reviewCount}`,
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          {
            severity: 'high',
            summary: 'Missing config validation',
            files: ['src/config.ts'],
          },
        ],
      };
    };

    let fixCount = 0;
    const runFix = async (_ctx: StepContext, _opts: FixStepOptions): Promise<FixStepResult> => {
      fixCount++;
      const currentHead = await git.headCommitSha(cwd);
      git.headByCwd.set(cwd, head2);
      return {
        invocationId: `fix-${fixCount}`,
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: currentHead,
      };
    };

    const deps: ReviewFixLoopDeps = {
      runPostFixGate: async () => ({ outcome: 'pass', output: '' }),
      runReview,
      runFix,
      runRevalidation: async () => ({ validationRunId: 'val-1', passed: true }),
      loops: new FakeLoopRepository(),
      events: bus,
      now: () => new Date('2026-01-01T00:00:00Z'),
      idFactory: () => 'loop-1',
      cleanArtifacts: async () => {},
      git,
    };

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute(baseInput());

    expect(result.needsHumanReview).toBe(true);
    const recurrenceEvent = events.find((e) => e.type === 'loop.exhausted.finding_recurrence');
    expect(recurrenceEvent).toBeDefined();
    expect(recurrenceEvent?.metadata?.fixChangedFiles).toEqual(['src/config.ts']);
    expect(recurrenceEvent?.metadata?.resolvedInIteration).toBe(1);
    expect(recurrenceEvent?.metadata?.recurringInIteration).toBe(2);
  });

  it('does not mark a finding resolved when the prior fix changed no anchored file', async () => {
    const { events, bus } = collectEvents();
    const git = new FakeGitPort();
    const cwd = '/wt';
    const head1 = 'head-sha-1';
    const head2 = 'head-sha-2';

    git.headByCwd.set(cwd, head1);
    // Fix delta ['src/other.ts'] does not intersect finding anchor ['src/config.ts']
    git.changedFiles = async (_cwd: string, _base: string, _head?: string) => ['src/other.ts'];

    let reviewCount = 0;
    const runReview = async (
      _ctx: StepContext,
      _opts?: ReviewStepOptions,
    ): Promise<ReviewStepResult> => {
      reviewCount++;
      return {
        invocationId: `rev-${reviewCount}`,
        agentOutcome: 'success',
        verdict: reviewCount <= 2 ? 'fail' : 'pass',
        offendingFindings: [
          {
            severity: 'high',
            summary: 'Missing config validation',
            files: ['src/config.ts'],
          },
        ],
      };
    };

    let fixCount = 0;
    const runFix = async (_ctx: StepContext, _opts: FixStepOptions): Promise<FixStepResult> => {
      fixCount++;
      const currentHead = await git.headCommitSha(cwd);
      git.headByCwd.set(cwd, head2);
      return {
        invocationId: `fix-${fixCount}`,
        agentOutcome: 'success',
        verdict: 'done_with_fixes',
        headBeforeFix: currentHead,
      };
    };

    const deps: ReviewFixLoopDeps = {
      runPostFixGate: async () => ({ outcome: 'pass', output: '' }),
      runReview,
      runFix,
      runRevalidation: async () => ({ validationRunId: 'val-1', passed: true }),
      loops: new FakeLoopRepository(),
      events: bus,
      now: () => new Date('2026-01-01T00:00:00Z'),
      idFactory: () => 'loop-1',
      cleanArtifacts: async () => {},
      git,
    };

    const loop = new ReviewFixLoop(deps);
    const result = await loop.execute(baseInput());

    expect(events.some((e) => e.type === 'loop.exhausted.finding_recurrence')).toBe(false);
    expect(fixCount).toBe(2);
    expect(result.phaseOutcome).toBe('passed');
  });
});
