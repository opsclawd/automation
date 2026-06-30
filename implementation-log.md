# Implementation Log - Task 2: Reorder PollTaskRunner reply persistence

## Summary of Changes
Enforced invariant 7 in `packages/application/src/pr-review/poll-task-runner.ts` by recording the reply attempt in the repository (`insertReply`) before persisting a `replied` comment state (`markReplied` and `upsertComment`) in both the successful `no_fix` and `fixed` paths.

Specifically:
- Updated the domain import in `poll-task-runner.ts` to import `markReplied`.
- Updated `postReplyIfMissing` to return `Promise<number>` containing the GitHub reply ID. It first searches for an existing reply matching the parent comment ID, and if not found, posts the reply, re-lists comments, and returns the newly posted reply's ID (throwing an error if it remains missing).
- Modified the `no_fix` path to first post the reply (and get the GitHub reply ID), insert the reply record in the database, call `markReplied` (which generates the correct replied comment using domain helper logic), and then upsert the replied comment. Verification (`verifyComment` and `markProcessed`) is performed on the returned domain-created replied comment.
- Modified the `fixed` path to follow the same ordering: push the changes, post the reply to obtain the ID, insert the reply record in the database, call `markReplied` (passing `commitSha` and other metadata), and then upsert the replied comment. Verification follows.
- Kept the `blocked` path behavior unchanged, except for awaiting but ignoring the return value of `postReplyIfMissing`.

## Verification Results
- `poll-task-runner-reply-order.test.ts` passes successfully, verifying the correct database operation ordering: `insertReply` occurs before `upsertComment` in the `replied` state.
- `poll-task-runner.test.ts` tests (including `happy path` and `failure isolation` patterns) pass successfully, verifying that all previous functional requirements are intact.
- The entire `pr-review` test suite runs and passes (115 tests).

# Implementation Log - Task 3: Pin validation failure diagnostic artifacts

## Summary of Changes
Strengthened invariant 10 for validation failures by asserting that the persisted `validate/failure.json` contains the same diagnostic artifact paths as the `Failure` object returned by `RunValidation`.

Specifically:
- In `packages/application/src/phases/handlers/__tests__/validate.test.ts`, updated the existing test `writes failure.json on validation failure` in `describe('artifact emission')`.
- Asserted that after parsing `validate/failure.json`, `parsed.artifacts` matches the expected diagnostic artifacts:
  - `validate/0-build.stdout.log`
  - `validate/0-build.stderr.log`
  - `validate/validation-result.json`
- Verified that the returned deferred result did not discard the diagnostic failure details by checking other fields in the parsed artifact JSON (including `parsed.kind`, `parsed.canRetry`, `parsed.runUuid`) instead of only checking phase and message.

## Verification Results
- Verified that all tests in `packages/application/src/phases/handlers/__tests__/validate.test.ts` pass, specifically the updated `writes failure.json on validation failure` test.
- Verified that `validation-run-to-failure.test.ts` passes the matching pattern tests.

