# Implementation Log

## Task 2: Replace retrySafe reruns with the shared result coordinator

Implemented the result coordinator and failure classification logic:
1. **Failure Classification**: Created [failure-classification.ts](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-720/packages/application/src/results/failure-classification.ts) containing helpers to classify result extraction failures based on whether bounded transcript evidence exists (identifying `serialization_artifact` vs. `unrecoverable_artifact`).
2. **Phase Registry**: Replaced the `retrySafe` boolean flag on the phase registry with `schemaContractText` specifying concise normalized JSON schema contract text. Added `normalizePhaseId` helper to normalize suffix-suffixed phase IDs (e.g. `fix-validate-1` to `fix-validate`).
3. **Extract Result Coordinator**: Refactored `extractResult` in [extract-result.ts](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-720/packages/application/src/results/extract-result.ts) to read, parse, and validate JSON results. If validation fails, it coordinates one-time repair using `StructuredResultRepairPort` if evidence exists; otherwise, returns classified failures under `unrecoverable_artifact`. Omitted repair dependency reverts to the same classified failure, keeping existing API composition callers working correctly.
4. **Handlers & Verdict Readers**: Updated verdict readers and `runSingleShotAgentPhase` to support coordinator-style extractResult, removing rerun side-effects and retaining contract checking.
5. **Testing & Verification**:
   - Replaced old retry matrix tests with compact tests verify repair/valid/thrown/terminal/mismatch scenarios.
   - Verified that no test references `retrySafe` or semantic reruns.
   - Run typecheck and verified packages/application test suite compiles and runs correctly.

## Task 3: Wire all result-artifact consumers through composition

Wired the structured result repair mechanisms and updated prompts/tests:
1. **Result Repair Construction**: Constructed `StructuredResultRepair` using the role-aware resolver for `result-writer` profile. Passed the `gitAdapter` (git cleanup adapter) and `artifactAgent` (capturing agent) to it.
2. **Coordinator Injection**: Injected the constructed `StructuredResultRepair` as `repair: structuredResultRepair` into every coordinator caller (`extractResult`, `readReviewVerdict`, and `readFixVerdict` invocations in `apps/api/src/compose.ts`).
3. **Lazy Config Validation**: Implemented a lazy check for the `result-writer` profile inside `resolveProfileBound` to fail configuration before any semantic agent dispatch while letting container construction in non-agent tests pass.
4. **Deterministic-Diagnostic Prompt Sections**: Added `deterministicDiagnostic` prompt section rendering to both plan-fix and review-fix prompts (`buildPlanReviewFixPrompt` and `buildReviewFixFixPrompt`).
5. **Testing & Verification**:
   - Created [compose-result-repair.test.ts](file:///home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-720/apps/api/src/__tests__/compose-result-repair.test.ts) covering malformed JSON output, writer profile routing, and coordinator result extraction.
   - Updated `compose-plan-review.test.ts` and `compose-arbiter.test.ts` to expect `schema` instead of `retrySafe`.
   - Verified that `vitest`, `tsc`, `eslint`, and `depcruise` all run and pass successfully.
