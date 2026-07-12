import { describe, expect, it } from 'vitest';
import { buildQualityReviewPrompt } from '../compose.js';

const ctx = {
  stepIndex: 3,
  stepTitle: 'Add pagination',
  cwd: '/workspace/.ai-worktrees/issue-55',
};
const typecheckSection =
  "## TYPECHECK RESULT (do not re-run — read-only phase)\nResult: PASS\n\nBUILD GREEN OVERRIDES THE PLAN'S LETTER: a plan-letter deviation that compiles is acceptable; do NOT return QUALITY_FAIL for it.";

const makeOptions = (
  overrides?: Partial<Parameters<typeof buildQualityReviewPrompt>[0]['scope']>,
) => ({
  ctx,
  typecheckSection,
  scope: {
    mode: 'initial_full' as const,
    dimensions: ['quality'] as Array<'spec' | 'quality'>,
    ...overrides,
  },
});

describe('buildQualityReviewPrompt', () => {
  it('includes a CONTEXT section with Working directory anchored to ctx.cwd', () => {
    const prompt = buildQualityReviewPrompt(makeOptions());
    expect(prompt).toContain('## CONTEXT');
    expect(prompt).toContain('## WORKSPACE CONSTRAINTS');
    expect(prompt).toContain(`Working directory: ${ctx.cwd}`);
  });

  it('output section uses absolute path for result.json', () => {
    const prompt = buildQualityReviewPrompt(makeOptions());
    expect(prompt).toContain(`Write ${ctx.cwd}/result.json`);
    expect(prompt).not.toContain('Write result.json');
  });

  it('includes negative constraint forbidding relative paths', () => {
    const prompt = buildQualityReviewPrompt(makeOptions());
    expect(prompt).toContain('Do NOT write to a relative path');
  });

  it('instructs the agent to use its file-write tool, not print the JSON in chat', () => {
    const prompt = buildQualityReviewPrompt(makeOptions());
    expect(prompt).toContain('You MUST use your file-write tool');
    expect(prompt).toContain('Printing the');
  });

  it('permits read-only inspection commands instead of forbidding all shell use', () => {
    const prompt = buildQualityReviewPrompt(makeOptions());
    expect(prompt).toContain('HARD CONSTRAINT — READ-ONLY REVIEW');
    expect(prompt).toContain('MUST NOT run tests, run builds');
    expect(prompt).toContain('Read-only shell commands for');
    expect(prompt).toContain('cat, ls, grep, git diff, git log');
  });

  it('includes the typecheck section', () => {
    const prompt = buildQualityReviewPrompt(makeOptions());
    expect(prompt).toContain('## TYPECHECK RESULT');
    expect(prompt).toContain('Result: PASS');
  });

  it('includes the step index and title in the task header', () => {
    const prompt = buildQualityReviewPrompt(makeOptions());
    expect(prompt).toContain('Review implementation quality for step 3: Add pagination');
  });

  it('output section defines the findings array contract', () => {
    const prompt = buildQualityReviewPrompt(makeOptions());
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"severity"');
    expect(prompt).toContain('"file": "<optional repo-relative path>"');
    expect(prompt).toContain('"suggested_fix"');
    expect(prompt).toContain('"P0" | "P1" | "P2" | "P3"');
  });

  it('output section forbids omitting findings on fail', () => {
    const prompt = buildQualityReviewPrompt(makeOptions());
    expect(prompt).toContain('Do NOT omit `findings` on "fail"');
  });

  it('renders mode as INITIAL FULL for initial_full mode', () => {
    const prompt = buildQualityReviewPrompt(makeOptions({ mode: 'initial_full' }));
    expect(prompt).toContain('## REVIEW MODE: INITIAL FULL');
  });

  it('renders mode as FINAL FULL for final_full mode', () => {
    const prompt = buildQualityReviewPrompt(makeOptions({ mode: 'final_full' }));
    expect(prompt).toContain('## REVIEW MODE: FINAL FULL');
  });

  it('renders delta mode with diff command for intermediate_delta', () => {
    const prompt = buildQualityReviewPrompt(
      makeOptions({
        mode: 'intermediate_delta',
        baseIdentity: 'abc123',
        snapshotIdentity: 'def456',
      }),
    );
    expect(prompt).toContain('## REVIEW MODE: DELTA (intermediate)');
    expect(prompt).toContain('git diff abc123..def456');
  });

  it('renders unresolved findings for intermediate_delta', () => {
    const prompt = buildQualityReviewPrompt(
      makeOptions({
        mode: 'intermediate_delta',
        unresolvedFindings: [
          { fingerprint: 'fp1', severity: 'P2', summary: 'Memory leak in cache' },
        ],
      }),
    );
    expect(prompt).toContain('## UNRESOLVED FINDINGS (from prior review)');
    expect(prompt).toContain('Memory leak in cache');
  });

  it('renders prior dispositions for intermediate_delta', () => {
    const prompt = buildQualityReviewPrompt(
      makeOptions({
        mode: 'intermediate_delta',
        dispositions: [{ fingerprint: 'fp1', disposition: 'rebutted' }],
      }),
    );
    expect(prompt).toContain('## PRIOR DISPOSITIONS');
    expect(prompt).toContain('fp1: rebutted');
  });
});
