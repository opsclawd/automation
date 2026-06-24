import { describe, expect, it } from 'vitest';
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

  it('falls back gracefully when taskText is empty', () => {
    const prompt = buildImplementPrompt(ctx, '', branchName);
    expect(prompt).toContain('## Task Description');
    expect(prompt).toContain('See plan.md Task 3 for details.');
  });

  it('includes the working directory, repo, branch, and reference files in Context', () => {
    const prompt = buildImplementPrompt(ctx, taskText, branchName);
    expect(prompt).toContain('## Context');
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

  it('includes PARITY COVERAGE section referencing watched legacy paths', () => {
    const prompt = buildImplementPrompt(ctx, taskText, branchName);
    expect(prompt).toContain('## PARITY COVERAGE');
    expect(prompt).toContain('watched legacy path');
    expect(prompt).toContain('scripts/ai-run-issue-v2');
    expect(prompt).toContain('legacy-parity.bats');
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
});
