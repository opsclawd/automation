import { describe, expect, it } from 'vitest';
import { buildPostPrReviewTaskPrompt } from '../compose.js';

describe('buildPostPrReviewTaskPrompt', () => {
  const baseInput = {
    cwd: '/workspace/.ai-worktrees/issue-42',
    comments: [
      {
        commentId: 1234,
        path: 'apps/api/src/compose.ts',
        line: 50,
        body: 'Fix this logic error',
      },
    ],
    attempt: 1,
    selectedContext: {
      files: [],
      hunks: [],
      symbols: [],
      expansionLevel: 1,
      tierReasoning: 'Tier 1',
    },
    diff: 'diff --git a/apps/api/src/compose.ts b/apps/api/src/compose.ts\n...',
    previousBuildError: undefined,
    previousCodeVerifyReason: undefined,
  };

  it('renders the base prompt correctly and asserts no-push instructions', () => {
    const prompt = buildPostPrReviewTaskPrompt(baseInput);

    expect(prompt).toContain('## WORKSPACE CONSTRAINTS');
    expect(prompt).toContain('Do NOT push');
    expect(prompt).toContain('commit the change locally');
    expect(prompt).not.toContain('git push');
    expect(prompt).not.toContain('commit and push');
  });

  it('requires agent to verify HEAD advanced after commit before reporting fixed', () => {
    const prompt = buildPostPrReviewTaskPrompt(baseInput);

    expect(prompt).toContain('PRE_HEAD=$(git rev-parse HEAD)');
    expect(prompt).toContain('COMMIT DID NOT ADVANCE HEAD');
    expect(prompt).toContain('WORKTREE DIRTY AFTER COMMIT');
    expect(prompt).toContain(
      'Only write action=fixed in result.json after steps d and e both pass',
    );
  });

  it('instructs agent to fix pre-commit hook failures before reporting done', () => {
    const prompt = buildPostPrReviewTaskPrompt(baseInput);

    expect(prompt).toContain('pre-commit hook failed');
    expect(prompt).toContain('FIX the reported errors');
    expect(prompt).toContain('Never report action=fixed');
  });

  it('includes previous build error and previous code verify reason when provided', () => {
    const inputWithErrors = {
      ...baseInput,
      attempt: 2,
      previousBuildError: 'The previous fix attempt failed the build with an error',
      previousCodeVerifyReason: 'Previous Fix Rejected by Code Verifier - reasoning here',
    };
    const prompt = buildPostPrReviewTaskPrompt(inputWithErrors as any);

    expect(prompt).toContain('The previous fix attempt failed the build');
    expect(prompt).toContain('Previous Fix Rejected by Code Verifier');
  });
});
