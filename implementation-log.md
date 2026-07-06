# Implementation Log — Task 6: Validate --base-branch and reject --model/--agent-cli for ts executor in cli.ts

## Status
DONE

## What was implemented
1. **Extended the `run` action's pre-validation block** in `apps/api/src/cli.ts` to reject conflicting combinations of `--executor ts` with `--model` or `--agent-cli`.
2. **Added `repoDefaultBranch` to `Container` interface and implementation** in `apps/api/src/compose.ts` so `cli.ts` can read the resolved default branch name.
3. **Implemented branch existence validation** in the TS executor path (`apps/api/src/cli.ts`) using `c.git.remoteRef` to ensure the effective base branch exists on `origin`.
4. **Passed resolved `baseBranch`** into `createRun` constructor.
5. **Emitted `run.config` info event** at run start for the TS executor path.
6. **Updated option descriptions** in Commander for `--base-branch`, `--model`, and `--agent-cli`.

## Files Changed
- [apps/api/src/cli.ts](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-634/apps/api/src/cli.ts)
- [apps/api/src/compose.ts](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-634/apps/api/src/compose.ts)
- [apps/api/src/__tests__/cli.test.ts](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-634/apps/api/src/__tests__/cli.test.ts)
- [implementation-log.md](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-634/implementation-log.md)

## Testing and Results
- Added two new unit tests under `describe('CLI run --executor ts')` in `apps/api/src/__tests__/cli.test.ts` to cover:
  - Rejection of `--model`/`--agent-cli` flags under `--executor ts`.
  - Failure/exit when the base branch is not found on remote origin.
- Globally mocked `remoteRef` to return `'mock-sha'` in the CLI test suite so that other TS-executor tests do not hit real network requests or fail due to nonexistent remote branch references.
- Ran all tests: `pnpm -r test` -> PASS.
- Ran layer validations: `pnpm depcruise` -> PASS (0 errors, 32 warnings).
- Ran lint check: `pnpm lint` -> PASS.
