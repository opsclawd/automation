# Task 11 — Test fixtures: remove wholePrFix from three remaining cli test files

## Scope
Remove the retired `wholePrFix: { maxIterations: 3 },` configuration line from three remaining cli test files:
- `apps/api/src/__tests__/cli-runs-target.test.ts`
- `apps/api/src/__tests__/cli-runs-resume-confirmation.test.ts`
- `apps/api/src/__tests__/cli-failure-output.test.ts`

## Changes

### apps/api/src/__tests__/cli-runs-target.test.ts
- Removed `wholePrFix: { maxIterations: 3 },` from line 40.

### apps/api/src/__tests__/cli-runs-resume-confirmation.test.ts
- Removed `wholePrFix: { maxIterations: 3 },` from line 53.

### apps/api/src/__tests__/cli-failure-output.test.ts
- Removed `wholePrFix: { maxIterations: 3 },` from line 54.

## Verification
- Ran all three test files:
  `pnpm --filter @ai-sdlc/api exec vitest run src/__tests__/cli-runs-target.test.ts src/__tests__/cli-runs-resume-confirmation.test.ts src/__tests__/cli-failure-output.test.ts`
  **Result**: 3/3 files passed, 13/13 tests passed.
- Ran typecheck on `@ai-sdlc/api`:
  `pnpm --filter @ai-sdlc/api run typecheck`
  **Result**: Passed successfully.

## Files changed
- `apps/api/src/__tests__/cli-runs-target.test.ts`
- `apps/api/src/__tests__/cli-runs-resume-confirmation.test.ts`
- `apps/api/src/__tests__/cli-failure-output.test.ts`
