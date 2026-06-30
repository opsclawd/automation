# Implementation Log - Task 6: Add Web Recovery Client And RunActions UI

Implemented thin client helpers and a run-detail Actions component that delegates recovery policy (cancellation, retrying, and resuming) to the API.

## Changes Made

### Web Package (`apps/web`)

- **Modified `apps/web/src/lib/api-client.ts`**:
  - Added TypeScript interfaces: `JobDto`, `RunActionSuccessDto`, and `ConfirmationRequiredDto`.
  - Added a custom typed `RunActionConfirmationRequiredError` class carrying the parsed 409 payload.
  - Implemented client-safe functions using relative URLs in the browser (or `apiUrl` on the server):
    - `cancelRunAction(runUuid, reason?)`
    - `retryRunAction(runUuid, confirm?)`
    - `resumeRunAction(runUuid, input?: { fromPhase?: string; confirm?: boolean })`
  - Handled dynamic construction of `RequestInit` options to avoid typescript compiler errors under `exactOptionalPropertyTypes: true`.

- **Created `apps/web/src/lib/__tests__/run-actions-api.test.ts`**:
  - Implemented 9 unit tests mocking `globalThis.fetch` to cover:
    - Success responses for cancel, retry, and resume.
    - Throwing `RunActionConfirmationRequiredError` on 409 confirmation-required errors.
    - Handling invalid responses (non-confirmation_required JSON, or syntax/parse errors) by throwing normal Errors.

- **Created `apps/web/src/components/RunActions.tsx`**:
  - Built a client-side component displaying run recovery control actions.
  - Displays "Cancel" button for any non-terminal status other than `failed`.
  - Displays "Resume" and "Retry phase" ("Retry phase") buttons for `failed` runs.
  - Added a compact phase selector dropdown (`<select>`) for explicit resume restarts, listing "Automatic (failed step)" followed by the 10 canonical phases from `CANONICAL_PHASE_ORDER`.
  - Disabled all actions and controls while a recovery request is in flight.
  - Handled `RunActionConfirmationRequiredError` by opening a modal dialog displaying the target phase and the server safety warning message.
  - Resubmits the failed action with `confirm: true` upon user confirmation.
  - Calls `router.refresh()` upon successful recovery action completion to update the page state.

- **Modified `apps/web/src/app/runs/[id]/page.tsx`**:
  - Imported and rendered `<RunActions run={run} />` in the run-detail header next to the run metadata.

## Verification Result

- Successfully type-checked the web package with no errors.
- Executed `vitest` unit tests covering the new client functions:
  - `pnpm exec vitest run apps/web/src/lib/__tests__/run-actions-api.test.ts`
  - All 9 unit tests passed successfully.
