# Implementation Log - Task 1: Add ARTIFACT_IN_BRAIN_DIR violation code

## Summary of Changes

### 1. `packages/application/src/ports/contract-violation-codes.ts`
- Added the `ARTIFACT_IN_BRAIN_DIR` contract violation code to the `CONTRACT_VIOLATION_CODES` object:
  ```ts
  ARTIFACT_IN_BRAIN_DIR: 'artifact_in_brain_dir',
  ```
- Positioned it immediately after `ARTIFACT_IN_SCRATCH_DIR` as required by the design/plan specifications.

## Verification
- Verified that the `packages/application` package builds successfully with no TypeScript compiler errors:
  ```bash
  pnpm --filter @ai-sdlc/application build
  ```
- Verified that all projects in the workspace typecheck cleanly:
  ```bash
  pnpm -r typecheck
  ```

---

# Implementation Log - Task 2: Inject cwd var in SingleShotAgentHandler + assert in compound tests

## Summary of Changes

### 1. `packages/application/src/phases/handlers/__tests__/compound.test.ts`
- Added an assertion in the happy path test to verify that `mockRenderPrompt` is called with the correct `cwd` variable inside the `vars` object (derived from `ctx.cwd`).

### 2. `packages/application/src/phases/handlers/single-shot-agent-handler.ts`
- Injected `cwd: ctx.cwd` into the `vars` object passed to `runSingleShotAgentPhase` around line 82.

## Verification
- Verified that the new assertion failed initially when `cwd` was not yet injected.
- Verified that all tests in `packages/application/src/phases/handlers/__tests__/compound.test.ts` passed successfully after implementation.
- Verified that all 729 tests in the `packages/application` package pass successfully.

---

# Implementation Log - Task 3: Update compound prompt template with absolute worktree path

## Summary of Changes

### 1. `prompts/compound/compound.md`
- Updated the write instruction to include the absolute working directory path explicitly using the injected `{{var:cwd}}` variable:
  ```
  Your working directory is: {{var:cwd}}
  Write your findings to `{{var:cwd}}/compound.md`.
  ```
- Updated the output format block paths to use `{{var:cwd}}` instead of bare file names for `compound.md`:
  ```
  Output format:
  - `{{var:cwd}}/compound.md`: A markdown document explaining what worked, what didn't, and what to do differently next time.
  - `result.json`: exactly this shape (fill in `summary` with one sentence describing the document):
    ```json
    { "result": "written", "path": "{{var:cwd}}/compound.md", "summary": "<one-sentence summary>" }
    ```
  ```

## Verification
- Verified the template contains the new `{{var:cwd}}` references by running `grep -n "var:cwd" prompts/compound/compound.md` and confirming at least 3 lines match.

---

# Implementation Log - Task 4: Write brain-dir recovery tests A (unique match + zero matches)

## Summary of Changes

### 1. `packages/infrastructure/src/agent/__tests__/antigravity-adapter.test.ts`
- Added two new failing `it` blocks to cover the brain-dir recovery logic:
  - `recovers artifact from brain dir when exactly one UUID dir has a matching file`: Tests the unique-match scenario. Fails because `brainDir` recovery has not yet been implemented, resulting in a `contract_violation` outcome instead of `success`.
  - `does not recover from brain dir when zero UUID dirs have the expected artifact`: Tests the zero-match scenario. Passes because recovery is not executed, leading correctly to `contract_violation`.

## Verification
- Ran the newly added tests to verify that they fail correctly as expected:
  - The unique match test failed with `AssertionError: expected 'contract_violation' to be 'success'`.
  - The zero match test passed as no recovery was performed.

---

# Implementation Log - Task 5: Implement brain-dir recovery in AntigravityAgentAdapter + parity test

## Summary of Changes

### 1. `packages/infrastructure/src/agent/antigravity-adapter.ts`
- Imported `basename` from `node:path`.
- Added the optional `brainDir?: string` field to `AntigravityAdapterOptions`.
- Added the `findArtifactInBrainDir` helper function to scan `brainRoot` subdirectories for a matching file, returning the match if unique, or `null` if none or multiple matches are found.
- Added a brain-dir recovery pass inside `invoke()` when the outcome is `contract_violation` and includes `MISSING_REQUIRED_ARTIFACT`. It iterates over expected artifacts, uses `findArtifactInBrainDir`, copies the unique matches using `copyFileSync`, records the `ARTIFACT_IN_BRAIN_DIR` contract violation, and updates the `outcome` to `success` if all expected artifacts are resolved.

### 2. `scripts/lib/__tests__/legacy-parity.bats`
- Appended the `parity[#530]` characterization test to assert that `AntigravityAgentAdapter` uses `ARTIFACT_IN_BRAIN_DIR`, `findArtifactInBrainDir`, `brainDir/brainRoot`, and `copyFileSync` (instead of renameSync) to maintain parity with legacy expectations.

## Verification
- Verified that all 27 tests in `packages/infrastructure/src/agent/__tests__/antigravity-adapter.test.ts` now pass, including the two brain-dir recovery tests added in Task 4.
- Verified that the new BATS parity test passes:
  ```bash
  bats scripts/lib/__tests__/legacy-parity.bats --filter "parity\[#530\]"
  ```


