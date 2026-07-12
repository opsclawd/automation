import { describe, expect, it } from 'vitest';
import { buildSpecReviewPrompt } from '../compose.js';

const ctx = {
  stepIndex: 2,
  stepTitle: 'Add auth middleware',
  cwd: '/workspace/.ai-worktrees/issue-42',
};
const typecheckSection = '## TYPECHECK RESULT (do not re-run — read-only phase)\nResult: PASS';

const makeOptions = (
  overrides?: Partial<Parameters<typeof buildSpecReviewPrompt>[0]['scope']>,
) => ({
  ctx,
  typecheckSection,
  implReport: '',
  scope: {
    mode: 'initial_full' as const,
    dimensions: ['spec'] as Array<'spec' | 'quality'>,
    ...overrides,
  },
});

describe('buildSpecReviewPrompt', () => {
  it('includes a CONTEXT section with Working directory anchored to ctx.cwd', () => {
    const prompt = buildSpecReviewPrompt(makeOptions());
    expect(prompt).toContain('## CONTEXT');
    expect(prompt).toContain('## WORKSPACE CONSTRAINTS');
    expect(prompt).toContain(`Working directory: ${ctx.cwd}`);
  });

  it('output section uses absolute path for result.json', () => {
    const prompt = buildSpecReviewPrompt(makeOptions());
    expect(prompt).toContain(`Write ${ctx.cwd}/result.json`);
    expect(prompt).not.toContain('Write result.json');
  });

  it('includes negative constraint forbidding relative paths', () => {
    const prompt = buildSpecReviewPrompt(makeOptions());
    expect(prompt).toContain('Do NOT write to a relative path');
  });

  it('instructs the agent to use its file-write tool, not print the JSON in chat', () => {
    const prompt = buildSpecReviewPrompt(makeOptions());
    expect(prompt).toContain('You MUST use your file-write tool');
    expect(prompt).toContain('Printing the');
  });

  it('includes the typecheck section', () => {
    const prompt = buildSpecReviewPrompt(makeOptions());
    expect(prompt).toContain('## TYPECHECK RESULT');
    expect(prompt).toContain('Result: PASS');
  });

  it('includes the step index and title in the task header', () => {
    const prompt = buildSpecReviewPrompt(makeOptions());
    expect(prompt).toContain('Review implementation of step 2: Add auth middleware');
  });

  it('includes the read-only hard constraint', () => {
    const prompt = buildSpecReviewPrompt(makeOptions());
    expect(prompt).toContain('HARD CONSTRAINT — READ-ONLY REVIEW');
    expect(prompt).toContain('MUST NOT run tests, run builds');
  });

  it('permits read-only inspection commands instead of forbidding all shell use', () => {
    const prompt = buildSpecReviewPrompt(makeOptions());
    expect(prompt).toContain('Read-only shell commands for');
    expect(prompt).toContain('cat, ls, grep, git diff, git log');
  });

  it('includes the stop rule', () => {
    const prompt = buildSpecReviewPrompt(makeOptions());
    expect(prompt).toContain('STOP RULE');
    expect(prompt).toContain('After writing result.json you are DONE');
  });

  it('output section defines the findings array contract', () => {
    const prompt = buildSpecReviewPrompt(makeOptions());
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"severity"');
    expect(prompt).toContain('"file": "<optional repo-relative path>"');
    expect(prompt).toContain('"suggested_fix"');
    expect(prompt).toContain('"P0" | "P1" | "P2" | "P3"');
  });

  it('output section forbids omitting findings on fail', () => {
    const prompt = buildSpecReviewPrompt(makeOptions());
    expect(prompt).toContain('Do NOT omit `findings` on "fail"');
  });

  it('embeds implementer report when provided', () => {
    const prompt = buildSpecReviewPrompt({
      ctx,
      typecheckSection,
      implReport: '## Status: DONE\nAll tests passed.',
      scope: { mode: 'initial_full' },
    });
    expect(prompt).toContain('## What the Implementer Claims');
    expect(prompt).toContain('All tests passed.');
  });

  it('omits implementer report section content when report is empty', () => {
    const prompt = buildSpecReviewPrompt({
      ctx,
      typecheckSection,
      implReport: '',
      scope: { mode: 'initial_full' },
    });
    expect(prompt).toContain('## What the Implementer Claims');
  });

  it('renders mode as INITIAL FULL for initial_full mode', () => {
    const prompt = buildSpecReviewPrompt(makeOptions({ mode: 'initial_full' }));
    expect(prompt).toContain('## REVIEW MODE: INITIAL FULL');
  });

  it('renders mode as FINAL FULL for final_full mode', () => {
    const prompt = buildSpecReviewPrompt(makeOptions({ mode: 'final_full' }));
    expect(prompt).toContain('## REVIEW MODE: FINAL FULL');
  });

  it('renders delta mode with diff command for intermediate_delta', () => {
    const prompt = buildSpecReviewPrompt(
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
    const prompt = buildSpecReviewPrompt(
      makeOptions({
        mode: 'intermediate_delta',
        unresolvedFindings: [
          { fingerprint: 'fp1', severity: 'P1', summary: 'Missing error handling' },
        ],
      }),
    );
    expect(prompt).toContain('## UNRESOLVED FINDINGS (from prior review)');
    expect(prompt).toContain('Missing error handling');
  });

  it('renders prior dispositions for intermediate_delta', () => {
    const prompt = buildSpecReviewPrompt(
      makeOptions({
        mode: 'intermediate_delta',
        dispositions: [{ fingerprint: 'fp1', disposition: 'addressed' }],
      }),
    );
    expect(prompt).toContain('## PRIOR DISPOSITIONS');
    expect(prompt).toContain('fp1: addressed');
  });
});
