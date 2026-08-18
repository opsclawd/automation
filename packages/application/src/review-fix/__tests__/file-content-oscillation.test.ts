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

type GitWithFileContent = FakeGitPort & {
  fileContent(cwd: string, ref: string, path: string): Promise<string>;
};

function baseInput(overrides?: Partial<ReviewFixLoopInput>): ReviewFixLoopInput {
  return {
    runId: RunId('run-oscillation-proof'),
    phaseId: PhaseName('review-fix'),
    repoId: 'owner/repo',
    cwd: '/wt',
    maxIterations: 3,
    reviewProfile: AgentProfileName('reviewer'),
    fixProfile: AgentProfileName('fixer'),
    baselineCommitSha: 'sha-a',
    manifest: {
      version: 2,
      task_count: 1,
      tasks: [
        {
          n: 1,
          title: 'Task 1',
          expected_files: ['vitest.integration.config.ts'],
        },
      ],
    },
    ...overrides,
  };
}

function collectEvents() {
  const events: OrchestratorEvent[] = [];
  const bus: EventBusPort = {
    publish: (_runUuid: string, e: OrchestratorEvent) => events.push(e),
    subscribe: () => () => {},
  };
  return { events, bus };
}

interface HarnessOptions {
  contents: Map<string, string>;
  progression?: 'a-b-a' | 'a-b-c';
}

function makeHarness(options: HarnessOptions) {
  const { events, bus } = collectEvents();
  const cwd = '/wt';
  const git = new FakeGitPort() as GitWithFileContent;
  git.headByCwd.set(cwd, 'sha-a');

  git.fileContent = async (_cwd: string, ref: string, path: string) => {
    const key = `${ref}:${path}`;
    const content = options.contents.get(key);
    if (content !== undefined) {
      return content;
    }
    throw new Error(`fileContent not found for ${key}`);
  };

  git.changedFiles = async (_cwd: string, _base: string, _head?: string) => [
    'vitest.integration.config.ts',
  ];

  git.amendCommitMessage = async (_cwd: string, _message: string) => {
    return git.headCommitSha(cwd);
  };

  const reviewCalls: Array<{ ctx: StepContext; opts?: ReviewStepOptions }> = [];
  let reviewCount = 0;
  const runReview = async (
    ctx: StepContext,
    opts?: ReviewStepOptions,
  ): Promise<ReviewStepResult> => {
    reviewCalls.push({ ctx, opts });
    reviewCount++;

    if (reviewCount === 1) {
      return {
        invocationId: 'rev-1',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          {
            severity: 'high',
            summary: 'Remove postgres integration tests from config',
            files: ['vitest.integration.config.ts'],
          },
        ],
      };
    }

    if (reviewCount === 2) {
      return {
        invocationId: 'rev-2',
        agentOutcome: 'success',
        verdict: 'fail',
        offendingFindings: [
          {
            severity: 'high',
            summary: 'Restore postgres integration tests to config',
            files: ['vitest.integration.config.ts'],
          },
        ],
      };
    }

    return {
      invocationId: `rev-${reviewCount}`,
      agentOutcome: 'success',
      verdict: 'pass',
      offendingFindings: [],
    };
  };

  const fixCalls: Array<{ ctx: StepContext; opts: FixStepOptions }> = [];
  const progression = options.progression ?? 'a-b-a';
  const fixShas = progression === 'a-b-a' ? ['sha-b', 'sha-a2'] : ['sha-b', 'sha-c'];

  const runFix = async (ctx: StepContext, opts: FixStepOptions): Promise<FixStepResult> => {
    const fixIndex = fixCalls.length;
    fixCalls.push({ ctx, opts });
    const currentHead = await git.headCommitSha(cwd);
    const nextSha = fixShas[fixIndex] ?? `sha-fix-${fixIndex + 1}`;
    git.headByCwd.set(cwd, nextSha);

    return {
      invocationId: `fix-${fixIndex + 1}`,
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: currentHead,
    };
  };

  const loops = new FakeLoopRepository();
  const deps: ReviewFixLoopDeps = {
    runPostFixGate: async () => ({ outcome: 'pass', output: '' }),
    runReview,
    runFix,
    runRevalidation: async () => ({ validationRunId: 'val-1', passed: true }),
    loops,
    events: bus,
    now: () => new Date('2026-01-01T00:00:00Z'),
    idFactory: () => 'loop-1',
    cleanArtifacts: async () => {},
    git,
  };

  const loop = new ReviewFixLoop(deps);

  return { loop, events, git, deps, fixCalls, reviewCalls };
}

describe('ReviewFixLoop single-file content oscillation', () => {
  it('halts on a single file whose content returns A to B to A', async () => {
    const contents = new Map([
      ['sha-a:vitest.integration.config.ts', "include: ['src/postgres/**']\n"],
      ['sha-b:vitest.integration.config.ts', 'include: []\n'],
      ['sha-a2:vitest.integration.config.ts', "include: ['src/postgres/**']\n"],
    ]);

    const { loop, events, fixCalls } = makeHarness({ contents });
    const result = await loop.execute(baseInput());

    expect(fixCalls).toHaveLength(2);
    expect(result.phaseOutcome).toBe('failed');
    expect(result.loopStatus).toBe('failed');
    expect(result.needsHumanReview).toBe(true);
    expect(events.some((e) => e.type === 'review_fix.file_oscillation_detected')).toBe(true);
  });

  it('reports the oscillating path and both contested contents', async () => {
    const contents = new Map([
      ['sha-a:vitest.integration.config.ts', "include: ['src/postgres/**']\n"],
      ['sha-b:vitest.integration.config.ts', 'include: []\n'],
      ['sha-a2:vitest.integration.config.ts', "include: ['src/postgres/**']\n"],
    ]);

    const { loop, events } = makeHarness({ contents });
    const result = await loop.execute(baseInput());

    expect(result.needsHumanReview).toBe(true);
    expect(result.humanReviewReason).toBeDefined();
    expect(result.humanReviewReason).toContain('vitest.integration.config.ts');
    expect(result.humanReviewReason).toContain("include: ['src/postgres/**']");
    expect(result.humanReviewReason).toContain('include: []');
    expect(result.humanReviewReason).toContain('sha-a');
    expect(result.humanReviewReason).toContain('sha-b');
    expect(result.humanReviewReason).toMatch(/1/);
    expect(result.humanReviewReason).toMatch(/2/);

    const oscillationEvent = events.find((e) => e.type === 'review_fix.file_oscillation_detected');
    expect(oscillationEvent).toBeDefined();
    expect(oscillationEvent?.metadata).toMatchObject(
      expect.objectContaining({
        path: 'vitest.integration.config.ts',
        repeatedContent: expect.stringContaining("include: ['src/postgres/**']"),
        contestedContent: expect.stringContaining('include: []'),
        repeatedSha: expect.stringContaining('sha-a'),
        contestedSha: expect.stringContaining('sha-b'),
        repeatedIteration: expect.any(Number),
        contestedIteration: expect.any(Number),
      }),
    );
  });

  it('does not flag a single file whose content progresses A to B to C', async () => {
    const contents = new Map([
      ['sha-a:vitest.integration.config.ts', "include: ['src/postgres/**']\n"],
      ['sha-b:vitest.integration.config.ts', 'include: []\n'],
      ['sha-c:vitest.integration.config.ts', "include: ['src/unit/**']\n"],
    ]);

    const { loop, events, fixCalls } = makeHarness({ contents, progression: 'a-b-c' });
    const result = await loop.execute(baseInput());

    expect(events.some((e) => e.type === 'review_fix.file_oscillation_detected')).toBe(false);
    expect(result.phaseOutcome).toBe('passed');
    expect(result.loopStatus).toBe('converged');
    expect(fixCalls).toHaveLength(2);
  });
});
