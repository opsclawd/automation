# Implementation Log - Task 5: Add Recovery REST Endpoints

Implemented the recovery REST endpoints to expose cancel, retry, and resume functionalities for Runs with server-side safety checks and confirmation flow enforcement.

## Changes Made

### API Package (`apps/api`)

- **Modified `apps/api/src/routes/runs.ts`**:
  - Implemented body parsing validators ensuring proper JSON objects and parameter types.
  - Implemented helper `apiWorkerId()` to return worker IDs formatted as `api-${process.pid}`.
  - Added `POST /api/runs/:runId/cancel`:
    - Validates UUID formatting and body presence.
    - Uses `planRunRecoveryAction` to check if cancellation is allowed.
    - If denied (run is in a terminal state), returns `409`.
    - Otherwise, executes `CancelRun` use case, refetches the Run, and returns `200 { run, action: 'cancel' }`.
  - Added `POST /api/runs/:runId/retry`:
    - Validates UUID formatting and body presence.
    - Resolves failed target phase and attempts using `planRunRecoveryAction`.
    - If denied (run not in failed state), returns `409`.
    - If target phase is unsafe and `confirm: true` is missing, returns `409 confirmation_required` with safety metadata.
    - Otherwise, calls `ResumeRun` usecase, refetches the Run and queued Job, and returns `202 { run, action: 'retry', ... }`.
  - Added `POST /api/runs/:runId/resume`:
    - Validates UUID formatting and body presence.
    - Determines resume target from existing progress or explicitly provided `fromPhase`.
    - Enforces the same confirmation flow for unsafe phases.
    - Initiates `ResumeRun` usecase (passing `fromPhase` and `attempt` only when restarting a phase).
    - Refetches the Run and queued Job, and returns `202 { run, action: 'resume', ... }`.
  - Mapped specific errors (e.g. `UnknownPhaseError` to `400`, missing run to `404`, denied/concurrent updates to `409`, others to `500`).

- **Created Route Tests `apps/api/src/__tests__/runs-recovery-routes.test.ts`**:
  - Wrote 11 test cases asserting:
    - Invalid UUID returns 400 for all endpoints.
    - Unknown valid UUID returns 404 for all endpoints.
    - Invalid body types and invalid values for `reason`, `confirm`, `fromPhase` return 400.
    - Cancel active Run returns 200 and correctly marks it as cancelled.
    - Cancel terminal Run returns 409.
    - Retry safe phase queues work without confirmation.
    - Retry unsafe phase without confirmation returns 409 confirmation required.
    - Retry unsafe phase with `confirm: true` enqueues the job and returns a queued status.
    - Resume without `fromPhase` queues default target.
    - Resume with unknown `fromPhase` returns 400.
    - Resume with unsafe `fromPhase` enforces confirmation checks.

## Verification Result
- Successfully type-checked the entire workspace.
- Ran all `@ai-sdlc/api` tests, confirming all 223 tests pass.
- Verified that all 11 new recovery routes tests pass successfully.
