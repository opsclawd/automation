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
