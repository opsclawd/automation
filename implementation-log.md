# Implementation Log - Task 2: Replace old remediation with universal find-based approach in external-cli-runner.ts

## Summary of Changes

### 1. `packages/infrastructure/src/agent/external-cli-runner.ts`
- Expanded imports from `node:fs` to include `readdirSync`, `statSync`, `copyFileSync`, and `unlinkSync`.
- Expanded imports from `node:path` to include `basename`.
- Implemented `findMisplacedCandidate(cwd: string, artifactBasename: string): string | null` to find exact basename matches of missing expected artifacts in the worktree:
  - Scans recursively using `readdirSync(..., { recursive: true })`.
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
