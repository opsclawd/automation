import { describe, expect, it } from 'vitest';
import {
  ArtifactNotFoundError,
  type ArtifactStore,
  WORKSPACE_CONSTRAINTS,
  SCRATCH_FILE_POLICY,
} from '@ai-sdlc/application';
import {
  buildImplementPrompt,
  buildImplementStepFixPrompt,
  buildPostPrReviewTaskPrompt,
} from '../compose.js';
import {
  buildReviewFixFixPrompt,
  buildReviewFixReviewPrompt,
  buildWholePrArbiterPrompt,
} from '../review-fix-prompts.js';
import { buildPlanReviewFixPrompt, buildPlanReviewReviewPrompt } from '../plan-review-prompts.js';

const SCRATCH_POLICY = [
  'Transient working files and scratch scripts MUST be written inside `.ai-tmp/`.',
  '`.ai-tmp/` is already gitignored.',
  'Nothing may be written to the worktree root unless it is a declared deliverable.',
] as const;

const missingArtifacts: ArtifactStore = {
  async read(runId, relativePath) {
    throw new ArtifactNotFoundError(runId, relativePath);
  },
  async write() {
    throw new Error('not in scope');
  },
  async list() {
    return [];
  },
  async hydrateWorktree() {},
};

function expectScratchPolicy(prompt: string): void {
  for (const instruction of SCRATCH_POLICY) {
    expect(prompt).toContain(instruction);
  }
}

function expectNoScratchPolicy(prompt: string): void {
  for (const instruction of SCRATCH_POLICY) {
    expect(prompt).not.toContain(instruction);
  }
}

describe('scratch workspace policy', () => {
  it('defines SCRATCH_FILE_POLICY with transient file instructions and leaves WORKSPACE_CONSTRAINTS clean', () => {
    expectScratchPolicy(SCRATCH_FILE_POLICY);
    expectNoScratchPolicy(WORKSPACE_CONSTRAINTS);
  });

  it('does not propagate scratch policy to read-only prompts', () => {
    const reviewPrompt = buildReviewFixReviewPrompt({
      cwd: '/worktree/issue-894',
      repoId: 'owner/repo',
      defaultBranch: 'main',
    });
    const arbiterPrompt = buildWholePrArbiterPrompt({
      cwd: '/worktree/issue-894',
      repoId: 'owner/repo',
      disputedFindings: [],
      dispositionHistory: [],
      relevantExcerpts: [],
      fixDelta: '',
      fixRebuttal: '',
    });

    expectNoScratchPolicy(reviewPrompt);
    expectNoScratchPolicy(arbiterPrompt);
  });

  it('propagates the scratch-file policy to implement prompts', () => {
    const prompt = buildImplementPrompt(
      {
        stepIndex: 1,
        stepTitle: 'Implement the change',
        cwd: '/worktree/issue-894',
        repoId: 'owner/repo',
      },
      'Task context',
      'ai/issue-894',
    );

    expectScratchPolicy(prompt);
  });

  it('propagates the scratch-file policy to the plan-review review prompt (issue #959)', () => {
    const prompt = buildPlanReviewReviewPrompt('# Base plan-review prompt');
    expectScratchPolicy(prompt);
  });

  it('propagates the scratch-file policy to fix-validate, review-fix, plan-fix, and PR review task prompts', async () => {
    const validateFixPrompt = await buildImplementStepFixPrompt(missingArtifacts, 'run-1', {
      cwd: '/worktree/issue-894',
      stepIndex: 1,
      stepTitle: 'Implement the change',
    });
    const reviewFixPrompt = buildReviewFixFixPrompt({
      cwd: '/worktree/issue-894',
      repoId: 'owner/repo',
      useFallback: false,
    });
    const planFixPrompt = buildPlanReviewFixPrompt('# Base plan fix prompt');
    const prReviewTaskPrompt = buildPostPrReviewTaskPrompt({
      cwd: '/worktree/issue-894',
      comment: {
        commentId: 1,
        path: 'src/index.ts',
        line: 10,
        body: 'Please fix this',
      },
      diff: 'diff --git a/src/index.ts b/src/index.ts',
      mode: 'initial_full',
    });

    expectScratchPolicy(validateFixPrompt);
    expectScratchPolicy(reviewFixPrompt);
    expectScratchPolicy(planFixPrompt);
    expectScratchPolicy(prReviewTaskPrompt);
  });
});
