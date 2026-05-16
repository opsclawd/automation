import { describe, expect, it } from 'vitest';
import { classifyExit } from '../classifier.js';

describe('classifyExit', () => {
  it('returns missing_artifact when log contains MISSING ARTIFACT sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'orchestrator_fail: MISSING ARTIFACT design.md',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('missing_artifact');
    expect(f.canRetry).toBe(false);
    expect(f.suggestedAction).toMatch(/inspect/i);
  });

  it('returns missing_artifact for "required artifact ... not found" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'required artifact design.md not found',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('missing_artifact');
  });

  it('returns missing_artifact for "Design doc not found after plan-design phase"', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Design doc not found after plan-design phase',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('missing_artifact');
  });

  it('returns missing_artifact for "Plan file not found after plan-write phase"', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Plan file not found after plan-write phase',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('missing_artifact');
  });

  it('returns missing_artifact for "plan.md not found in worktree"', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'plan.md not found in worktree',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('missing_artifact');
  });

  it('returns invalid_result when log contains invalid result file', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'invalid result file: parse error',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('invalid_result');
  });

  it('returns branch_changed when log contains "branch changed from" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'check_branch_after_agent: branch changed from issue-1 to main',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('branch_changed');
  });

  it('returns branch_changed for wrapper "switched branch from" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'FAIL: Agent switched branch from issue-6 to main',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('branch_changed');
  });

  it('returns timeout for "TIMEOUT" sentinel', () => {
    const f = classifyExit({
      exitCode: 124,
      combinedLogTail: 'TIMEOUT after 600s',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('timeout');
  });

  it('returns timeout for "timed out" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'process timed out after 120s',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('timeout');
  });

  it('returns validation_failed for "validate phase failed" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'validate phase failed: typecheck',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('validation_failed');
  });

  it('returns validation_failed for pnpm test failed', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'pnpm test failed with exit code 1',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('validation_failed');
  });

  it('returns validation_failed for [build failed] bracketed sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: '[build failed]',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('validation_failed');
  });

  it('returns validation_failed for [lint failed] bracketed sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: '[lint failed]',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('validation_failed');
  });

  it('returns validation_failed for [typecheck failed] bracketed sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: '[typecheck failed]',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('validation_failed');
  });

  it('returns validation_failed for [test failed] bracketed sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: '[test failed]',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('validation_failed');
  });

  it('returns github_failed for "gh: api error" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'gh: api error - rate limit exceeded',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('github_failed');
  });

  it('returns git_failed for "fatal:" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'fatal: not a git repository',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('git_failed');
  });

  it('returns git_failed for "fatal:" without "git" word after it', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'fatal: invalid reference: origin/main',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('git_failed');
  });

  it('returns git_failed for "Failed to push branch" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Failed to push branch ai/issue-6',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('git_failed');
  });

  it('returns git_failed for "Failed to checkout ... in worktree" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Failed to checkout ai/issue-6 in worktree',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('git_failed');
  });

  it('returns git_failed for "Failed to attach worktree to local branch" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Failed to attach worktree to local branch ai/issue-6',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('git_failed');
  });

  it('returns git_failed for "Failed to recreate worktree from origin" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Failed to recreate worktree from origin/ai/issue-6',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('git_failed');
  });

  it('returns git_failed for "is still not a worktree" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: '/path/to/dir is still not a worktree after recovery',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('git_failed');
  });

  it('returns agent_blocked when log contains agent reported BLOCKED', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'agent reported BLOCKED: unclear requirements',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('agent_blocked');
  });

  it('returns agent_blocked for wrapper "Phase ... is blocked" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: "Phase 'implement' is blocked (agent emitted BLOCKED)",
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('agent_blocked');
  });

  it('returns agent_blocked for "Task N is BLOCKED" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Task 1 is BLOCKED. Fix the blocker and re-run.',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('agent_blocked');
  });

  it('returns command_failed for exit 1 with no sentinel match', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'something went wrong\nstack trace here',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('command_failed');
    expect(f.canRetry).toBe(false);
    expect(f.message).toContain('something went wrong');
  });

  it('returns unknown for non-1 non-zero exit with no sentinel match', () => {
    const f = classifyExit({
      exitCode: 137,
      combinedLogTail: 'killed',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('unknown');
    expect(f.exitCode).toBe(137);
  });

  it('extracts the last phase from the log', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail:
        'starting phase plan-write\nplan-write done\nstarting phase implement\norchestrator_fail',
      runUuid: 'test-uuid',
    });
    expect(f.phase).toBe('implement');
  });

  it('extracts phase from "=== Phase:" format (wrapper output)', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: '=== Phase: validate ===\nsome error output\nFAIL: something',
      runUuid: 'test-uuid',
    });
    expect(f.phase).toBe('validate');
  });

  it('extracts phase from "starting phase" format', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail:
        'starting phase plan-write\nplan-write done\nstarting phase implement\norchestrator_fail',
      runUuid: 'test-uuid',
    });
    expect(f.phase).toBe('implement');
  });

  it('extracts phase from PHASE= format', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'PHASE=implement\nsome error output',
      runUuid: 'test-uuid',
    });
    expect(f.phase).toBe('implement');
  });

  it('picks the last phase when multiple are present', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail:
        'starting phase plan-write\nPHASE=implement\nstarting phase validate\nTIMEOUT after 60s',
      runUuid: 'test-uuid',
    });
    expect(f.phase).toBe('validate');
  });

  it('returns undefined phase when no phase markers are in the log', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'just some random error output',
      runUuid: 'test-uuid',
    });
    expect(f.phase).toBeUndefined();
  });

  it('populates runUuid from input', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'TIMEOUT after 600s',
      runUuid: 'test-uuid-123',
    });
    expect(f.runUuid).toBe('test-uuid-123');
  });

  it('populates artifacts when provided', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'TIMEOUT after 600s',
      runUuid: 'test-uuid',
      artifacts: ['/path/to/stdout.log', '/path/to/stderr.log'],
    });
    expect(f.artifacts).toEqual(['/path/to/stdout.log', '/path/to/stderr.log']);
  });

  it('defaults canRetry to false for every kind', () => {
    const tails = [
      'MISSING ARTIFACT design.md',
      'required artifact design.md not found',
      'Design doc not found after plan-design phase',
      'invalid result file',
      'branch changed from x to y',
      'timed out',
      'TIMEOUT after 600s',
      'validate phase failed',
      'pnpm test failed',
      '[build failed]',
      '[test failed]',
      'gh: api error',
      'fatal: git error',
      'fatal: invalid reference: origin/main',
      'Failed to push branch ai/issue-6',
      'Failed to checkout ai/issue-6 in worktree',
      'Failed to attach worktree to local branch issue-6',
      'Failed to recreate worktree from origin/issue-6',
      '/repo is still not a worktree after recovery',
      'agent reported BLOCKED',
      "Phase 'implement' is blocked",
      'switched branch from main to issue-1',
    ];
    for (const tail of tails) {
      const f = classifyExit({ exitCode: 1, combinedLogTail: tail, runUuid: 'test-uuid' });
      expect(f.canRetry).toBe(false);
    }
  });

  it('uses the last 3 non-empty lines as fallback message when no sentinel matches', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'line1\n\nline2\n\nline3\nline4\nline5',
      runUuid: 'test-uuid',
    });
    expect(f.message).toBe('line3\nline4\nline5');
  });

  it('defaults detectedAt to current Date when not provided', () => {
    const before = new Date();
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'TIMEOUT after 600s',
      runUuid: 'test-uuid',
    });
    const after = new Date();
    expect(f.detectedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(f.detectedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('uses provided detectedAt when given', () => {
    const dt = new Date('2026-05-13T19:23:00Z');
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'TIMEOUT after 600s',
      runUuid: 'test-uuid',
      detectedAt: dt,
    });
    expect(f.detectedAt).toBe(dt);
  });

  it('preserves the full containing line as message for missing_artifact', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail:
        'running phase plan-design\nDesign doc not found after plan-design phase\nexit 1',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('missing_artifact');
    expect(f.message).toBe('Design doc not found after plan-design phase');
  });

  it('preserves the full containing line as message for git_failed', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'pushing code\nFailed to push branch ai/issue-6 to origin\nexit 1',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('git_failed');
    expect(f.message).toBe('Failed to push branch ai/issue-6 to origin');
  });

  it('preserves the full containing line as message for branch_changed', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'check_branch_after_agent: branch changed from issue-1 to main\nexit 1',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('branch_changed');
    expect(f.message).toBe('check_branch_after_agent: branch changed from issue-1 to main');
  });
});
