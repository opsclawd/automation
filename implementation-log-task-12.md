# Task 12 — Bats tests: update phase_iteration_config.bats to reference reviewFix

## Scope
Update the BATS test cases in `scripts/lib/__tests__/phase_iteration_config.bats` that reference the retired `wholePrFix.maxIterations` / `MAX_WHOLE_PR_FIX_ITERATIONS` config to reference `reviewFix.maxIterations` / `MAX_REVIEW_FIX_ITERATIONS` instead, aligned with the retirement of the `wholePrFix` schema key.

## Changes

### scripts/lib/__tests__/phase_iteration_config.bats
- Modified the following tests:
  - `"defaults: when config file is missing, defaults are 5, 2"`: Removed obsolete `[ "$MAX_WHOLE_PR_FIX_ITERATIONS" = "10" ]` assertion.
  - `"reads reviewFix.maxIterations from config (wholePrFix removed in #667)"`: Changed from reading `wholePrFix.maxIterations` / `MAX_WHOLE_PR_FIX_ITERATIONS` to `reviewFix.maxIterations` / `MAX_REVIEW_FIX_ITERATIONS`.
  - `"falls back to default when reviewFix key is absent (wholePrFix removed in #667)"`: Changed from testing `wholePrFix` fallback to `reviewFix` fallback when the key is absent.
  - `"falls back to defaults on malformed JSON"`: Removed obsolete `[ "$MAX_WHOLE_PR_FIX_ITERATIONS" = "10" ]` assertion.
  - `"logs effective limits on startup (wholePrFix removed in #667)"`: Changed log check to assert only `reviewFix.maxIterations` is logged (since `wholePrFix` is removed).

## Verification
- Ran the targeted bats test file:
  `pnpm exec bats scripts/lib/__tests__/phase_iteration_config.bats`
  **Result**: 18/18 tests passed.
- Ran all workspace-wide verification suites:
  - `pnpm test:bash` (659/659 tests passed)
  - `pnpm -r typecheck` (Passed)
  - `pnpm depcruise` (Passed, 0 errors)
  - `pnpm lint` (Passed, 0 errors)
  - `pnpm -r test` (Passed, 108/108 tests passed)

## Files changed
- `scripts/lib/__tests__/phase_iteration_config.bats`
