import { describe, expect, it } from 'vitest';
import { buildPostPrReviewTaskPrompt } from '../compose.js';

describe('buildPostPrReviewTaskPrompt', () => {
  const baseInput = {
    cwd: '/workspace/.ai-worktrees/issue-42',
    comment: {
      commentId: 1234,
      path: 'apps/api/src/compose.ts',
      line: 50,
      body: 'Fix this logic error',
    },
    diff: 'diff --git a/apps/api/src/compose.ts b/apps/api/src/compose.ts\n...',
  };

  it('renders the base prompt correctly and asserts no-push instructions', () => {
    const prompt = buildPostPrReviewTaskPrompt(baseInput);

    expect(prompt).toContain('Do NOT push');
    expect(prompt).toContain('commit the change locally');
    expect(prompt).not.toContain('git push');
    expect(prompt).not.toContain('commit and push');
  });

  it('includes previous build error and previous code verify reason when provided', () => {
    const inputWithErrors = {
      ...baseInput,
      previousBuildError: 'The previous fix attempt failed the build with an error',
      previousCodeVerifyReason: 'Previous Fix Rejected by Code Verifier - reasoning here',
    };
    const prompt = buildPostPrReviewTaskPrompt(inputWithErrors);

    expect(prompt).toContain('The previous fix attempt failed the build');
    expect(prompt).toContain('Previous Fix Rejected by Code Verifier');
  });
});
