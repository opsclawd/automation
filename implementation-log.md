# Implementation Log - Coalesce empty currentPhase in RetryFailedPhase

## Completed Work
### Task 1: Coalesce empty `currentPhase` in `RetryFailedPhase` and add regression test
- Modified [retry-failed-phase.test.ts](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-515/packages/application/src/__tests__/retry-failed-phase.test.ts) to add regression tests for when `currentPhase` is an empty string.
- Modified [retry-failed-phase.ts](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-515/packages/application/src/retry-failed-phase.ts) to coalesce an empty-string `currentPhase` to `null` so it correctly falls back to phase records.
- Verified that the tests failed as expected before the fix (TDD cycle) and passed after the fix.
- Ran the full test suite for `@ai-sdlc/application` and all 730 tests passed successfully.
- Ran TypeScript compilation check and it succeeded with no errors.

### Task 2: Prevent empty `currentPhase` from propagating through `ResumeRun` rollbacks
- Modified [resume-run.ts](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-515/packages/application/src/resume-run.ts#L67) to normalise empty `currentPhase` strings to `null` via `run.currentPhase || null` in the rollback/saved transition state path.
- Verified all application tests in `resume-run.test.ts` pass, confirming no regressions.
- Ran the full test suite for `@ai-sdlc/application` and all 730 tests passed successfully.
- Ran TypeScript compilation check and it succeeded with no errors.
### Task 3: Write `currentPhase` to the DB when `StartIssueRun` records a failure, with test
- Modified [start-issue-run.ts](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-515/packages/application/src/start-issue-run.ts) to conditionally update the run record with `currentPhase: failure.phase` when `failure.phase` is present.
- Modified [start-issue-run.test.ts](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-515/packages/application/src/__tests__/start-issue-run.test.ts) to add unit tests confirming that `failure.phase` is propagated as `currentPhase` on run failure when available, and is omitted from the update payload when unavailable.
- Verified that tests fail as expected (TDD cycle) when the feature is missing and pass after applying the fix.
- Ran all tests across the repository and they all passed successfully.
- Verified that TypeScript type checking compiles successfully with no warnings or errors.
