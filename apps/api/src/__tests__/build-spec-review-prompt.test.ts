import { describe, expect, it } from 'vitest';
import { buildSpecReviewPrompt } from '../compose.js';

const ctx = {
  stepIndex: 2,
  stepTitle: 'Add auth middleware',
  cwd: '/workspace/.ai-worktrees/issue-42',
};
const typecheckSection = '## TYPECHECK RESULT (do not re-run — read-only phase)\nResult: PASS';

describe('buildSpecReviewPrompt', () => {
  it('includes a CONTEXT section with Working directory anchored to ctx.cwd', () => {
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('## CONTEXT');
    expect(prompt).toContain(`Working directory: ${ctx.cwd}`);
  });

  it('output section uses absolute path for result.json', () => {
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain(`Write ${ctx.cwd}/result.json:`);
    expect(prompt).not.toContain('Write result.json:');
  });

  it('includes negative constraint forbidding relative paths', () => {
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('Do NOT write to a relative path');
  });

  it('includes the typecheck section', () => {
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('## TYPECHECK RESULT');
    expect(prompt).toContain('Result: PASS');
  });

  it('includes the step index and title in the task header', () => {
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('Review implementation of step 2: Add auth middleware');
  });
});
