import { describe, expect, it } from 'vitest';
import { buildPostPrReviewTaskPrompt } from '../compose.js';

describe('compose-pr-review-attempts', () => {
  const baseInput = {
    cwd: '/workspace/.ai-worktrees/issue-42',
    comment: {
      commentId: 1234,
      path: 'apps/api/src/compose.ts',
      line: 50,
      body: 'Fix this logic error',
    },
    diff: 'diff --git a/apps/api/src/compose.ts b/apps/api/src/compose.ts\n...',
    mode: 'initial_full' as const,
  };

  describe('buildPostPrReviewTaskPrompt mode awareness', () => {
    it('renders "Attempt Mode: INITIAL FULL" for initial_full mode', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        mode: 'initial_full',
      });
      expect(prompt).toContain('## Attempt Mode: INITIAL FULL');
    });

    it('renders "Attempt Mode: INTERMEDIATE DELTA" for intermediate_delta mode', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        mode: 'intermediate_delta',
      });
      expect(prompt).toContain('## Attempt Mode: INTERMEDIATE DELTA');
    });

    it('includes mode header before the comment context', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        mode: 'initial_full',
      });
      const modeIndex = prompt.indexOf('## Attempt Mode: INITIAL FULL');
      const commentIndex = prompt.indexOf('Address the following PR review comment:');
      expect(modeIndex).toBeLessThan(commentIndex);
    });
  });

  describe('per-comment prompt isolation', () => {
    it('renders only the specific comment in the prompt', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        comment: {
          commentId: 9999,
          path: 'src/utils.ts',
          line: 42,
          body: 'Consider using a more efficient algorithm',
        },
        mode: 'initial_full',
      });
      expect(prompt).toContain('commentId: 9999');
      expect(prompt).toContain('src/utils.ts:42');
      expect(prompt).toContain('Consider using a more efficient algorithm');
    });

    it('does not include unrelated comments', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        comment: {
          commentId: 1111,
          path: 'src/a.ts',
          line: 10,
          body: 'First comment',
        },
        mode: 'initial_full',
      });
      expect(prompt).toContain('commentId: 1111');
      expect(prompt).not.toContain('commentId: 2222');
      expect(prompt).not.toContain('Second comment');
    });
  });

  describe('retry delta behavior', () => {
    it('renders mode as INTERMEDIATE DELTA for retry attempts', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        mode: 'intermediate_delta',
      });
      expect(prompt).toContain('## Attempt Mode: INTERMEDIATE DELTA');
    });

    it('still includes previous build error context in intermediate_delta mode', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        mode: 'intermediate_delta',
        previousBuildError: 'TS2322: Type mismatch',
      });
      expect(prompt).toContain('Previous Attempt Failed');
      expect(prompt).toContain('TS2322: Type mismatch');
    });

    it('still includes previous code verify reason in intermediate_delta mode', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        mode: 'intermediate_delta',
        previousCodeVerifyReason: 'variable still mutable',
      });
      expect(prompt).toContain('Previous Fix Rejected by Code Verifier');
      expect(prompt).toContain('variable still mutable');
    });

    it('renders intermediate_delta mode after initial_full with all error context', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        mode: 'intermediate_delta',
        previousBuildError: 'TS2722: Cannot invoke object',
        previousCodeVerifyReason: 'verifier rejected fix',
      });
      expect(prompt).toContain('## Attempt Mode: INTERMEDIATE DELTA');
      expect(prompt).toContain('Previous Attempt Failed');
      expect(prompt).toContain('TS2722');
      expect(prompt).toContain('Previous Fix Rejected by Code Verifier');
      expect(prompt).toContain('verifier rejected fix');
    });
  });

  describe('normal first-attempt/processed behavior', () => {
    it('renders clean initial_full prompt without error context', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        mode: 'initial_full',
      });
      expect(prompt).toContain('## Attempt Mode: INITIAL FULL');
      expect(prompt).not.toContain('Previous Attempt Failed');
      expect(prompt).not.toContain('Previous Fix Rejected by Code Verifier');
    });

    it('renders full diff section for initial_full mode', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@',
        mode: 'initial_full',
      });
      expect(prompt).toContain('## Current Diff');
      expect(prompt).toContain('diff --git a/src/a.ts b/src/a.ts');
    });

    it('includes no-push and commit verification instructions', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        mode: 'initial_full',
      });
      expect(prompt).toContain('Do NOT push');
      expect(prompt).toContain('PRE_HEAD=$(git rev-parse HEAD)');
      expect(prompt).toContain('COMMIT DID NOT ADVANCE HEAD');
    });
  });

  describe('only-own-feedback behavior', () => {
    it('includes only the specific previousBuildError provided', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        mode: 'intermediate_delta',
        previousBuildError: 'Only this specific error',
      });
      expect(prompt).toContain('Only this specific error');
      expect(prompt).not.toContain('Another error');
    });

    it('includes only the specific previousCodeVerifyReason provided', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        mode: 'intermediate_delta',
        previousCodeVerifyReason: 'Only this specific reason',
      });
      expect(prompt).toContain('Only this specific reason');
      expect(prompt).not.toContain('Another reason');
    });

    it('renders clean prompt when no previous feedback provided', () => {
      const prompt = buildPostPrReviewTaskPrompt({
        ...baseInput,
        mode: 'intermediate_delta',
      });
      expect(prompt).not.toContain('Previous Attempt Failed');
      expect(prompt).not.toContain('Previous Fix Rejected by Code Verifier');
    });
  });
});
