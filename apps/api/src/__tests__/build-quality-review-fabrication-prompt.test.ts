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

describe('buildQualityReviewPrompt fabrication guidance', () => {
  it('teaches the reviewer to distinguish fabricated evidence from an ordinary defect', () => {
    const prompt = buildQualityReviewPrompt(makeOptions());

    expect(prompt).toContain('"result": "pass" | "fail" | "fabricated"');
    expect(prompt).toContain(
      'Use "fabricated" only when the implementation presents evidence as the result of external physical execution',
    );
    expect(prompt).toContain('provenance establishes that execution did not occur');
    expect(prompt).toContain(
      'Use ordinary "fail" for buggy, inconsistent, incomplete, or low-quality output when fabrication is not established',
    );
    expect(prompt).toContain(
      'A "fabricated" result hard-fails the Step and is not sent to a fixer',
    );
  });
});
