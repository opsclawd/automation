# Implementation Log - Task 2: Replace old remediation with universal find-based approach in external-cli-runner.ts

## Summary of Changes

### 1. `packages/infrastructure/src/agent/external-cli-runner.ts`
- Expanded imports from `node:fs` to include `readdirSync`, `statSync`, `copyFileSync`, and `unlinkSync`.
- Expanded imports from `node:path` to include `basename`.
- Implemented `findMisplacedCandidate(cwd: string, artifactBasename: string): string | null` to find exact basename matches of missing expected artifacts in the worktree:
  - Scans recursively using manual recursion via a helper function with `readdirSync` to enforce depth checks and ignore specific noise directories.
  - Skips top-level/depth < 2 files.
  - Excludes files that reside in any noise directory (like `node_modules`, `.git`, `dist`, etc.).
  - Restricts matches to files only (using `statSync(fullPath).isFile()`).
  - Guards against moving git-tracked files by verifying status with `git ls-files --error-unmatch`.
  - Ensures remediation only happens when there is exactly one unique candidate (ambiguous matches are skipped).
- Implemented `moveMisplacedArtifact(cwd: string, srcRelative: string, destRelative: string): void` to move the candidate to the expected destination:
  - Uses `renameSync(src, dest)`.
  - Handles cross-device renames by falling back to `copyFileSync(src, dest)` and `unlinkSync(src)` on `EXDEV` error.
  - Cleans up empty ancestor directories up to the workspace root.
- Removed the old pre-check `design.md`-only remediation block.
- Integrated the new universal post-check remediation block right after the artifact enforcement loop (only runs if the outcome was `contract_violation` with `MISSING_REQUIRED_ARTIFACT`).
  - Attempts to find and remediate each missing expected artifact.
  - If all expected artifacts are successfully remediated, swaps the violation code to `MISPLACED_ARTIFACT`, restores outcome to `'success'`, logs the warning to `stderr.log`, and updates `remediatedArtifacts` in the result metadata.

### 2. `scripts/lib/__tests__/legacy-parity.bats`
- Replaced the body of `parity[#504]` to match the new `readdirSync`, `basename`, and single-candidate requirements.
- Added `parity[#527]` test verifying the new post-check gitignore-aware find-based scan with `EXDEV` fallback, `NOISE_DIRS` exclusion, and `MISPLACED_ARTIFACT` status conversion.

# Implementation Log - Task 3: Update existing artifact remediation tests to match new exact-basename approach

## Summary of Changes

### 1. `packages/infrastructure/src/agent/__tests__/external-cli-runner.test.ts`
- Updated the 5 existing tests in the `artifact remediation` describe block to use exact basename matches instead of timestamp-prefixed filenames:
  - **"moves misplaced design.md from subdirectory to worktree root"**: Changed the subdir filename from `2026-04-26-ops-57-fix-score-trace-build-design.md` to `design.md` and updated `remediatedArtifacts` expectations accordingly.
  - **"does not remediate when design.md already exists at root"**: Changed the subdir filename from `2026-04-26-design.md` to `design.md`.
  - **"does not remediate when multiple untracked matching files exist"**: Created two untracked files both named `design.md` in different subdirectories (`docs/a/design.md` and `docs/b/design.md`) instead of pattern-matched names.
  - **"does not remediate when the misplaced file is git-tracked"**: Changed subdir filename to `design.md` and git-added/committed it before execution.
  - **"cleans up empty ancestor directories after moving misplaced file"**: Changed subdir filename to `design.md` and updated expectations to assert both `specDir` and parent `docs` directory are cleaned up.

# Implementation Log - Task 4: Add new artifact remediation tests

## Summary of Changes

### 1. `packages/infrastructure/src/agent/__tests__/external-cli-runner.test.ts`
- Imported `vi` and `afterEach` from `vitest` at the top of the test file.
- Mocked `node:fs`'s `renameSync` to spy on calls and easily mock its implementation dynamically across tests, while delegating to the actual `renameSync` from `importOriginal` by default.
- Added a teardown step in `afterEach` to call `vi.restoreAllMocks()` and clean up any spies/mocks between tests.
- Added 5 new unit tests under the `artifact remediation` describe block:
  - **"moves misplaced plan.md from subdirectory to worktree root"**: Verifies that a misplaced `plan.md` file is correctly moved and results in a `success` outcome.
  - **"moves misplaced compound.md from subdirectory to worktree root"**: Verifies that a misplaced `compound.md` file is correctly moved and results in a `success` outcome.
  - **"remediates misplaced artifact even when the file is gitignored"**: Verifies that a gitignored misplaced `plan.md` is successfully remediated (reproducing the primary driver for using `readdirSync` over `git ls-files`).
  - **"remains contract_violation when only some artifacts can be remediated"**: Verifies that if multiple artifacts are expected and one is absent while the other is misplaced, the outcome remains `contract_violation` (partial remediation).
  - **"falls back to copy+unlink on EXDEV rename error"**: Mocks `renameSync` to throw an `EXDEV` error on the first call (using `vi.importActual` to invoke the real FS method on fallback) and asserts that the file is successfully copied and unlinked, resulting in a `success` outcome.
