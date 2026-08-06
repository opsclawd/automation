# Implementation Log - Task 3: Make issue-label transitions fatal and resume-safe

## Summary
Made issue-label updates in `CreatePrHandler` fatal on failure and resume-safe by:
1. Emitting an error-level `github.label_update_failed` event and returning `github_failed` (with `canRetry: true`) if `updateIssueLabels` fails during open PR reuse.
2. Reordering new PR creation steps so that `pr-url.txt` artifact is written immediately after `createPullRequest` and before `updateIssueLabels`.
3. Adding `pr-url.txt` to `writtenArtifacts` upon successful write so that if `updateIssueLabels` fails on a newly created PR, the failure result references `pr-url.txt` and allows safe resumption without duplicate PR creation.
4. Emitting `create_pr.completed` only after `updateIssueLabels` resolves successfully.

## Verification
- Unit tests added and verified in `packages/application/src/phases/handlers/__tests__/create-pr.test.ts`:
  - `fails when label transition fails while reusing an open pull request`
  - `persists a newly created pull request before failing its label transition`
  - `resumes a created pull request after a label transition failure without creating a duplicate`
  - `passes only after the required label transition succeeds`
- All 36 tests in `create-pr.test.ts` pass cleanly.
- `pnpm -r build`, `pnpm -r typecheck`, `pnpm lint`, and `pnpm -r test` all pass cleanly across the entire workspace.
