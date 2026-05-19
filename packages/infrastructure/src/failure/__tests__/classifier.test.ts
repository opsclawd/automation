import { describe, expect, it } from 'vitest';
import { classifyExit } from '../classifier.js';
import type { ClassifierEvent } from '../classifier.js';

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

  it('returns invalid_result for "No tasks found in plan.md" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'No tasks found in plan.md',
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

  it('returns git_failed for "Worktree missing and no local or remote branch" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Worktree missing and no local or remote branch ai/issue-6 to recover from',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('git_failed');
  });

  it('returns git_failed for "Worktree creation failed" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Worktree creation failed — /path/to/dir is not a git worktree',
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

  it('returns agent_blocked for "Task N is NEEDS_CONTEXT" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Task 3 is NEEDS_CONTEXT. Fix the blocker and re-run.',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('agent_blocked');
  });

  it('returns agent_blocked for "fix review is blocked" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Task 2 fix review is blocked. Fix the blocker and re-run.',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('agent_blocked');
  });

  it('returns agent_blocked for "ai:blocked" label sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'orchestrator_fail: Issue has ai:blocked label',
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
      'No tasks found in plan.md',
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
      'Worktree missing and no local or remote branch issue-6',
      'Worktree creation failed — /dir is not a git worktree',
      'Worktree has no commits — cannot create PR',
      'Failed to create PR and no open PR exists for branch ai/issue-6',
      'Task 1 fix-review has no findings to act on (no .md, no .log)',
      'agent reported BLOCKED',
      "Phase 'implement' is blocked",
      'Task 3 is NEEDS_CONTEXT',
      'Task 2 fix review is blocked',
      'ai:blocked',
      'Orchestrator is blocked from previous phase',
      'reviews failing and fix-agent reported no fixes',
      'Failed to fetch issue #42',
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

  it('classifies based on the last sentinel in the log, not the first pattern match', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail:
        '=== Phase: validate ===\n[build failed]\n=== Phase: review ===\nFailed to push branch ai/issue-6',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('git_failed');
    expect(f.message).toContain('Failed to push branch');
  });

  it('classifies based on last sentinel when earlier sentinel is from an earlier table entry', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail:
        'validate phase failed: typecheck\nstarting phase create-pr\nFailed to push branch ai/issue-6 to origin',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('git_failed');
    expect(f.message).toContain('Failed to push branch');
  });

  it('still matches when only one sentinel is present regardless of position', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: '[build failed]',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('validation_failed');
  });

  it('picks the last match within the same pattern when log contains multiple bracketed failures', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: '[build failed]\n[lint failed]\n[typecheck failed]\n[test failed]',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('validation_failed');
    expect(f.message).toBe('[test failed]');
  });

  it('returns git_failed for "Worktree has no commits" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Worktree has no commits — cannot create PR',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('git_failed');
  });

  it('returns agent_blocked for "Orchestrator is blocked from previous phase" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Orchestrator is blocked from previous phase',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('agent_blocked');
  });

  it('returns missing_artifact for "fix-review has no findings" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail:
        'Task 1 fix-review has no findings to act on (no .md, no .log). Reviewer agents must write detailed findings.',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('missing_artifact');
  });

  it('returns github_failed for "Failed to create PR and no open PR" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Failed to create PR and no open PR exists for branch ai/issue-6',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('github_failed');
  });

  it('returns github_failed for "Failed to fetch issue" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail: 'Failed to fetch issue #42',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('github_failed');
  });

  it('returns agent_blocked for "reviews failing" sentinel', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail:
        'Task 1: reviews failing (spec=fail, quality=fail) and fix-agent reported no fixes.',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('agent_blocked');
  });

  it('classifies create-pr abort correctly when earlier validate produced [build failed]', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail:
        '=== Phase: validate ===\n[build failed]\n=== Phase: create-pr ===\nWorktree has no commits — cannot create PR',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('git_failed');
    expect(f.message).toContain('Worktree has no commits');
  });

  it('classifies PR creation failure as github_failed when after validation failure', () => {
    const f = classifyExit({
      exitCode: 1,
      combinedLogTail:
        '=== Phase: validate ===\n[build failed]\n=== Phase: create-pr ===\nFailed to create PR and no open PR exists for branch ai/issue-6',
      runUuid: 'test-uuid',
    });
    expect(f.kind).toBe('github_failed');
    expect(f.message).toContain('Failed to create PR');
  });
});

describe('classifyExit with events (M2-06)', () => {
  const baseInput = {
    runUuid: '00000000-0000-0000-0000-000000000001',
    combinedLogTail: '',
    exitCode: 1,
    artifacts: [] as string[],
  };
  const ev = (over: Partial<ClassifierEvent>): ClassifierEvent => ({
    level: 'error',
    type: 'phase.failed',
    message: '',
    timestamp: '2026-05-16T12:00:00.000Z',
    metadata: {},
    ...over,
  });
  it('prefers phase.failed event over log scraping for validation_failed', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({
          phase: 'validate',
          message: 'validate suite failed',
          metadata: { command: 'pnpm build', exitCode: 2, reason: 'build failed' },
        }),
      ],
      combinedLogTail: 'gh: api error\nfatal: nothing here',
    });
    expect(failure.kind).toBe('validation_failed');
    expect(failure.phase).toBe('validate');
    expect(failure.message).toMatch(/pnpm build/);
    expect(failure.exitCode).toBe(2);
  });
  it('classifies missing_artifact when metadata.missingArtifact is set', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({
          phase: 'plan-write',
          message: 'plan.md missing',
          metadata: { missingArtifact: 'plan.md' },
        }),
      ],
    });
    expect(failure.kind).toBe('missing_artifact');
    expect(failure.phase).toBe('plan-write');
    expect(failure.message).toMatch(/plan\.md/);
  });
  it('classifies branch_changed via metadata.reason', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({
          phase: 'implement',
          message: 'switched branch from ai/issue-1 to main',
          metadata: { reason: 'branch changed' },
        }),
      ],
    });
    expect(failure.kind).toBe('branch_changed');
  });
  it('classifies timeout via metadata.reason matching /timeout|timed out/i', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({
          phase: 'implement',
          message: 'agent timed out after 600s',
          metadata: { reason: 'timed out' },
        }),
      ],
    });
    expect(failure.kind).toBe('timeout');
  });
  it('classifies agent_blocked from loop.exhausted', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({
          phase: 'fix-review',
          type: 'loop.exhausted',
          message: 'fix-review hit max iterations for task 2',
          metadata: { task: 2, iterations: 5 },
        }),
      ],
    });
    expect(failure.kind).toBe('agent_blocked');
    expect(failure.phase).toBe('fix-review');
  });
  it('classifies agent_blocked via metadata.reason matching /blocked/i', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({
          phase: 'implement',
          message: 'agent blocked itself',
          metadata: { reason: 'BLOCKED' },
        }),
      ],
    });
    expect(failure.kind).toBe('agent_blocked');
  });
  it('falls back to log scraping when no terminal event present', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [ev({ phase: 'plan-write', type: 'phase.started', level: 'info' })],
      combinedLogTail: 'pnpm typecheck failed',
    });
    expect(failure.kind).toBe('validation_failed');
  });
  it('falls back to log scraping when events is empty', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [],
      combinedLogTail: 'MISSING ARTIFACT design.md',
    });
    expect(failure.kind).toBe('missing_artifact');
  });
  it('uses the event timestamp for detectedAt', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({
          phase: 'validate',
          message: 'build failed',
          metadata: { command: 'pnpm build', exitCode: 2 },
        }),
      ],
    });
    expect(failure.detectedAt.toISOString()).toBe('2026-05-16T12:00:00.000Z');
  });
  it('uses the most recent phase.failed when multiple exist', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({
          phase: 'validate',
          message: 'first',
          metadata: { reason: 'timed out' },
          timestamp: '2026-05-16T12:00:00.000Z',
        }),
        ev({
          phase: 'review',
          message: 'second',
          metadata: { reason: 'BLOCKED' },
          timestamp: '2026-05-16T12:01:00.000Z',
        }),
      ],
    });
    expect(failure.kind).toBe('agent_blocked');
    expect(failure.phase).toBe('review');
  });
  it('returns unknown when only run.failed is present', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({
          type: 'run.failed',
          message: 'something exploded',
          metadata: { reason: 'something exploded', lastPhase: 'implement' },
        }),
      ],
    });
    expect(failure.kind).toBe('unknown');
    expect(failure.message).toMatch(/something exploded/);
  });
  it('classifies invalid_result via metadata.reason', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({
          phase: 'plan-write',
          message: 'invalid result',
          metadata: { reason: 'invalid result format' },
        }),
      ],
    });
    expect(failure.kind).toBe('invalid_result');
  });
  it('falls through to command_failed when phase.failed has no matching metadata rule', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({
          phase: 'implement',
          message: 'some unhandled error',
          metadata: { reason: 'generic failure' },
        }),
      ],
      combinedLogTail: 'line1\nline2\nline3\nline4',
    });
    expect(failure.kind).toBe('command_failed');
    expect(failure.message).toMatch(/some unhandled error/);
    expect(failure.message).toMatch(/line4/);
  });

  it('uses event message alone for command_failed when no log tail is available', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({
          phase: 'implement',
          message: 'unhandled event error',
          metadata: { reason: 'generic failure' },
        }),
      ],
      combinedLogTail: '',
    });
    expect(failure.kind).toBe('command_failed');
    expect(failure.message).toBe('unhandled event error');
  });
  it('prefers loop.exhausted over phase.failed so exhausted review loops classify as agent_blocked', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({
          phase: 'implement',
          type: 'run.failed',
          message: 'run failed',
          timestamp: '2026-05-16T12:00:00.000Z',
        }),
        ev({
          phase: 'fix-review',
          type: 'loop.exhausted',
          message: 'Review loop hit max iterations for task 2',
          metadata: { reason: 'blocked' },
        }),
        ev({
          phase: 'fix-review',
          type: 'phase.failed',
          message: 'Review loop hit max iterations for task 2',
          metadata: { reason: 'Review loop hit max' },
        }),
      ],
    });
    expect(failure.kind).toBe('agent_blocked');
    expect(failure.phase).toBe('fix-review');
  });
  it('prefers loop.exhausted over run.failed when no phase.failed', () => {
    const failure = classifyExit({
      ...baseInput,
      events: [
        ev({ type: 'run.failed', message: 'run failed', timestamp: '2026-05-16T12:00:00.000Z' }),
        ev({
          phase: 'fix-review',
          type: 'loop.exhausted',
          message: 'loop exhausted',
          metadata: { reason: 'blocked' },
        }),
      ],
    });
    expect(failure.kind).toBe('agent_blocked');
  });
});
