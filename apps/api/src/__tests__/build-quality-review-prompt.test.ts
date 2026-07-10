import { describe, expect, it } from 'vitest';
import { buildQualityReviewPrompt } from '../compose.js';

const ctx = {
  stepIndex: 3,
  stepTitle: 'Add pagination',
  cwd: '/workspace/.ai-worktrees/issue-55',
};
const typecheckSection =
  "## TYPECHECK RESULT (do not re-run — read-only phase)\nResult: PASS\n\nBUILD GREEN OVERRIDES THE PLAN'S LETTER: a plan-letter deviation that compiles is acceptable; do NOT return QUALITY_FAIL for it.";

describe('buildQualityReviewPrompt', () => {
  it('includes a CONTEXT section with Working directory anchored to ctx.cwd', () => {
    const prompt = buildQualityReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('## CONTEXT');
    expect(prompt).toContain('## WORKSPACE CONSTRAINTS');
    expect(prompt).toContain(`Working directory: ${ctx.cwd}`);
  });

  it('output section uses absolute path for result.json', () => {
    const prompt = buildQualityReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain(`Write ${ctx.cwd}/result.json`);
    expect(prompt).not.toContain('Write result.json');
  });

  it('includes negative constraint forbidding relative paths', () => {
    const prompt = buildQualityReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('Do NOT write to a relative path');
  });

  it('includes the typecheck section', () => {
    const prompt = buildQualityReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('## TYPECHECK RESULT');
    expect(prompt).toContain('Result: PASS');
  });

  it('includes the step index and title in the task header', () => {
    const prompt = buildQualityReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('Review implementation quality for step 3: Add pagination');
  });

  it('output section defines the findings array contract', () => {
    const prompt = buildQualityReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"severity"');
    expect(prompt).toContain('"file": "<optional repo-relative path>"');
    expect(prompt).toContain('"suggested_fix"');
    expect(prompt).toContain('"P0" | "P1" | "P2" | "P3"');
  });

  it('output section forbids omitting findings on fail', () => {
    const prompt = buildQualityReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('Do NOT omit `findings` on "fail"');
  });
});
