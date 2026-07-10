import { describe, expect, it } from 'vitest';
import type { TypescriptError } from '@ai-sdlc/application';
import { buildImplementPrompt } from '../compose.js';

const ctx = {
  stepIndex: 3,
  stepTitle: 'Add authentication',
  cwd: '/workspace/issue-42',
  repoId: 'opsclawd/automation',
};
const taskText = 'Implement JWT-based auth middleware and write integration tests.';
const branchName = 'ai/issue-42';

describe('buildImplementPrompt', () => {
  it('opens with the task header identifying task number and title', () => {
    const prompt = buildImplementPrompt(ctx, taskText, branchName);
    expect(prompt).toMatch(/^You are implementing Task 3: Add authentication/);
  });

  it('includes the full task text in the Task Description section', () => {
    const prompt = buildImplementPrompt(ctx, taskText, branchName);
    expect(prompt).toContain('## Task Description');
    expect(prompt).toContain('Implement JWT-based auth middleware and write integration tests.');
  });

  // Kept explicitly for direct helper formatting compatibility (Task 4)
  it('falls back gracefully when taskText is empty', () => {
    const prompt = buildImplementPrompt(ctx, '', branchName);
    expect(prompt).toContain('## Task Description');
    expect(prompt).toContain('See plan.md Task 3 for details.');
  });

  it('includes the working directory, repo, branch, and reference files in Context', () => {
    const prompt = buildImplementPrompt(ctx, taskText, branchName);
    expect(prompt).toContain('## Context');
    expect(prompt).toContain('## WORKSPACE CONSTRAINTS');
    expect(prompt).toContain('/workspace/issue-42');
    expect(prompt).toContain('opsclawd/automation');
    expect(prompt).toContain('ai/issue-42');
    expect(prompt).toContain('issue.md');
    expect(prompt).toContain('design.md');
    expect(prompt).toContain('plan.md');
  });

  it('includes SCOPE RESTRICTION section naming the task number', () => {
    const prompt = buildImplementPrompt(ctx, taskText, branchName);
    expect(prompt).toContain('## SCOPE RESTRICTION');
    expect(prompt).toContain('ONLY Task 3');
    expect(prompt).toContain('numbered higher than 3');
  });

  it('includes Your Job section with commit verification commands', () => {
    const prompt = buildImplementPrompt(ctx, taskText, branchName);
    expect(prompt).toContain('## Your Job');
    expect(prompt).toContain('git rev-parse HEAD');
    expect(prompt).toContain('git status --porcelain');
  });

  it('includes Self-Review Checklist with scope and commit integrity checks', () => {
    const prompt = buildImplementPrompt(ctx, taskText, branchName);
    expect(prompt).toContain('## Self-Review Checklist');
    expect(prompt).toContain('git diff --stat HEAD~1');
    expect(prompt).toContain('Task 3 alone');
  });

  it('includes Report Format section with all four status values', () => {
    const prompt = buildImplementPrompt(ctx, taskText, branchName);
    expect(prompt).toContain('## Report Format');
    expect(prompt).toContain('DONE');
    expect(prompt).toContain('DONE_WITH_CONCERNS');
    expect(prompt).toContain('BLOCKED');
    expect(prompt).toContain('NEEDS_CONTEXT');
  });

  it('includes branch restriction naming the exact branch', () => {
    const prompt = buildImplementPrompt(ctx, taskText, branchName);
    expect(prompt).toContain('ai/issue-42');
    expect(prompt).toContain('git checkout');
    expect(prompt).toContain('git switch');
    expect(prompt).toContain('git stash branch');
  });

  it('does NOT include MANDATORY RESULT FILE instruction', () => {
    const prompt = buildImplementPrompt(ctx, taskText, branchName);
    expect(prompt).not.toContain('MANDATORY RESULT FILE');
    expect(prompt).not.toContain('.result');
  });

  it('instructs agent to write summary to implementation-log.md', () => {
    const prompt = buildImplementPrompt(ctx, taskText, branchName);
    expect(prompt).toContain('implementation-log.md');
  });

  it('renders structured typecheck errors grouped by file', () => {
    const errors: TypescriptError[] = [
      {
        file: 'src/domain/run.ts',
        line: 45,
        col: 10,
        code: 'TS2339',
        message: "Property 'repoId' does not exist on type 'Run'",
      },
      {
        file: 'src/domain/run.ts',
        line: 78,
        col: 3,
        code: 'TS2345',
        message: 'Argument of type string is not assignable',
      },
      {
        file: 'src/application/start-run.ts',
        line: 12,
        col: 7,
        code: 'TS2339',
        message: "Property 'repoId' does not exist",
      },
    ];
    const prompt = buildImplementPrompt(
      { stepIndex: 1, stepTitle: 'Add repoId', cwd: '/cwd', repoId: 'org/repo' },
      'task body',
      'ai/issue-1',
      errors,
    );
    expect(prompt).toContain('## Typecheck Errors From Previous Attempt (3 errors in 2 files)');
    expect(prompt).toContain('### src/domain/run.ts (2 errors)');
    expect(prompt).toContain('- Line 45: TS2339:');
    expect(prompt).toContain('### src/application/start-run.ts (1 error)');
    expect(prompt).toContain('- Line 12: TS2339:');
  });

  it('omits typecheck errors section when typecheckErrors is undefined', () => {
    const prompt = buildImplementPrompt(
      { stepIndex: 1, stepTitle: 'T', cwd: '/c', repoId: 'r' },
      '',
      'branch',
      undefined,
    );
    expect(prompt).not.toContain('Typecheck Errors From Previous Attempt');
  });

  it('omits typecheck errors section when typecheckErrors is empty array', () => {
    const prompt = buildImplementPrompt(
      { stepIndex: 1, stepTitle: 'T', cwd: '/c', repoId: 'r' },
      '',
      'branch',
      [],
    );
    expect(prompt).not.toContain('Typecheck Errors From Previous Attempt');
  });

  it('renders unparsed string typecheck output as a code block when adapter did not produce structured errors', () => {
    const raw = 'Build failed: some generic syntax error';
    const prompt = buildImplementPrompt(
      { stepIndex: 1, stepTitle: 'T', cwd: '/c', repoId: 'r' },
      '',
      'branch',
      raw,
    );
    expect(prompt).toContain('## Typecheck Errors From Previous Attempt (unparsed output)');
    expect(prompt).toContain('```');
    expect(prompt).toContain(raw);
  });

  it('parses a string of TSC output into structured errors when given as a string', () => {
    const raw = "src/foo.ts(1,2): error TS2339: Property 'x' does not exist on type 'Y'";
    const prompt = buildImplementPrompt(
      { stepIndex: 1, stepTitle: 'T', cwd: '/c', repoId: 'r' },
      '',
      'branch',
      raw,
    );
    expect(prompt).toContain('## Typecheck Errors From Previous Attempt (1 error in 1 file)');
    expect(prompt).toContain('### src/foo.ts (1 error)');
    expect(prompt).toContain('- Line 1: TS2339:');
  });
});
