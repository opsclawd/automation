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
    expect(prompt).toContain('## WORKSPACE CONSTRAINTS');
    expect(prompt).toContain(`Working directory: ${ctx.cwd}`);
  });

  it('output section uses absolute path for result.json', () => {
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain(`Write ${ctx.cwd}/result.json`);
    expect(prompt).not.toContain('Write result.json');
  });

  it('includes negative constraint forbidding relative paths', () => {
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('Do NOT write to a relative path');
  });

  it('instructs the agent to use its file-write tool, not print the JSON in chat', () => {
    // Weaker models (e.g. gpt-5.4-mini) sometimes answer with the result JSON
    // as their final chat message instead of writing result.json to disk,
    // triggering a missing_required_artifact fallback. Make the requirement explicit.
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('You MUST use your file-write tool');
    expect(prompt).toContain('Printing the');
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

  it('includes the read-only hard constraint', () => {
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('HARD CONSTRAINT — READ-ONLY REVIEW');
    expect(prompt).toContain('MUST NOT run tests, run builds');
  });

  it('permits read-only inspection commands instead of forbidding all shell use', () => {
    // A weaker model (e.g. gpt-5.4-mini on codex) with no dedicated file-read
    // tool has no way to comply with a blanket "no shell commands" rule —
    // codex's only real file-read mechanism is `cat`. Confirmed live: this
    // caused a quality-review invocation to burn ~1M tokens flailing between
    // web search and other tools rather than just reading the diff, then
    // fail without ever writing result.json.
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('Read-only shell commands for');
    expect(prompt).toContain('cat, ls, grep, git diff, git log');
  });

  it('includes the stop rule', () => {
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('STOP RULE');
    expect(prompt).toContain('After writing result.json you are DONE');
  });

  it('output section defines the findings array contract', () => {
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('"findings"');
    expect(prompt).toContain('"severity"');
    expect(prompt).toContain('"file": "<optional repo-relative path>"');
    expect(prompt).toContain('"suggested_fix"');
    expect(prompt).toContain('"P0" | "P1" | "P2" | "P3"');
  });

  it('output section forbids omitting findings on fail', () => {
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection);
    expect(prompt).toContain('Do NOT omit `findings` on "fail"');
  });

  it('embeds implementer report when provided', () => {
    const implReport = '## Status: DONE\nAll tests passed.';
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection, implReport);
    expect(prompt).toContain('## What the Implementer Claims');
    expect(prompt).toContain('All tests passed.');
  });

  it('omits implementer report section content when report is empty', () => {
    const prompt = buildSpecReviewPrompt(ctx, typecheckSection, '');
    expect(prompt).toContain('## What the Implementer Claims');
  });
});
