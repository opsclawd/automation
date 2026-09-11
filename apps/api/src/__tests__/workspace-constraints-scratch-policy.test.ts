import { describe, expect, it } from 'vitest';
import { WORKSPACE_CONSTRAINTS, SCRATCH_FILE_POLICY } from '@ai-sdlc/application';
import { buildPostPrReviewTaskPrompt, buildPostPrReviewBatchPrompt } from '../compose.js';
import { buildReviewFixFixPrompt } from '../review-fix-prompts.js';

const SCRATCH_POLICY = [
  'Transient working files and scratch scripts MUST be written inside `.ai-tmp/`.',
  '`.ai-tmp/` is already gitignored.',
  'Nothing may be written to the worktree root unless it is a declared deliverable.',
] as const;

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

  it('propagates the scratch-file policy to fix and PR review task prompts', async () => {
    const reviewFixPrompt = buildReviewFixFixPrompt({
      cwd: '/worktree/issue-894',
      repoId: 'owner/repo',
      useFallback: false,
    });
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
    const prReviewBatchPrompt = buildPostPrReviewBatchPrompt({
      cwd: '/worktree/issue-894',
      comments: [
        {
          commentId: 1,
          path: 'src/index.ts',
          line: 10,
          body: 'Please fix this',
        },
      ],
      diffsByCommentId: new Map([[1, 'diff --git a/src/index.ts b/src/index.ts']]),
      mode: 'initial_full',
      dispositions: [],
      context: {
        level: 'file',
        includedFiles: [],
        includedHunks: [],
        includedSymbols: [],
        fullDiffIncluded: false,
        sections: [],
      },
    });

    expectScratchPolicy(reviewFixPrompt);
    expectScratchPolicy(prReviewTaskPrompt);
    expectScratchPolicy(prReviewBatchPrompt);
  });
});
