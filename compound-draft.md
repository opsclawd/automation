# ProcessPrReviewComments Use Case — Compound Document

## Problem and Context

The orchestrator needed a TypeScript use case to process PR review comments in a single pass, porting the core logic from Bash (`scripts/ai-pr-review-poll` + `scripts/lib/comment-state.sh`). The Bash implementation was opaque, hard to test in isolation, and tightly coupled to filesystem and subprocess mechanics.

**Goal**: Create a testable, port-driven application-layer use case that the in-process scheduler (M6-04) can call repeatedly. Each invocation = one `PollAttempt`.

**Why it matters**: Porting to TypeScript with injected ports enables deterministic testing via fakes, proper observability via the event bus, and clean layer separation enforced by `pnpm depcruise`.

## Key Design Decisions

### D1: Result Schema Reconciliation

**Decision**: Align `postPrReviewResultSchema` with the shipped Bash agent's contract.

**Before**: `{ result: 'handled' | 'nothing_to_handle', repliesPosted: number }`
**After**: `{ outcome: 'ALL_DONE' | 'NO_FIXES_NEEDED' | 'PARTIAL' | 'BLOCKED', comments: PostPrReviewComment[] }`

**Why**: The existing schema didn't match the agent's `validate_result_file` contract. The agent validates `ALL_DONE | NO_FIXES_NEEDED | PARTIAL | BLOCKED` and a per-comment reply manifest. Aligning ensures `extractResult` validation works correctly.

**Trade-off considered**: This is a breaking change, but nothing in the codebase currently parses this schema at runtime (the registry entry exists but no code path exercises it for `post-pr-review` yet), so the migration is safe.

### D2: `extractResult` Injection Strategy

**Decision**: Inject `extractResult` as a simplified function dependency rather than using the full `extractResult` function with `AgentInvocation` and `ArtifactStore` ports.

```typescript
extractResult: (input: {
  resultJsonPath?: string;
  cwd: string;
}) => Promise<{ ok: true; result: PostPrReviewResult } | { ok: false; reason: string; detail: string }>;
```

**Why**: The existing `extractResult` function expects an `AgentInvocation` domain object and ports. The use case doesn't need to know about `AgentInvocation` internals. The real adapter in `apps/api/src/compose.ts` will wrap the full call, constructing a synthetic `AgentInvocation` from the `AgentInvocationResult`.

**Trade-off**: The use case cannot re-invoke the agent on `retrySafe` failure (that responsibility moves to the adapter). Since `post-pr-review` is `retrySafe: false`, this is moot for M6-03 but would need consideration if that changes.

### D3: Verification as Function Dependencies

**Decision**: Inject `verifyCommitPushed` and `verifyBuildPasses` as function dependencies rather than calling `GitPort`/`ValidationPort` directly.

**Why**:
- `verifyCommitPushed` requires multi-step logic: get `headCommitSha`, then check `remoteRef` to see if it's on the branch. This is orchestration logic, not a single port call.
- `verifyBuildPasses` requires the repo's validation commands from `.ai-orchestrator.json`, which the use case doesn't have access to. The adapter reads config and calls `ValidationPort.run()`.
- Function injection keeps the use case testable with trivial fakes and decoupled from config loading.

### D4: Reply Verification Approach

**Decision**: After posting a reply, re-fetch comments via `github.listReviewComments()` and check if any comment has `inReplyToId === item.commentId`.

**Why**: `GitHubPort.replyToReviewComment` returns `void` — it doesn't return the created reply's ID. This mirrors the shell's `verify_replies_posted` semantics.

**Critical implementation detail**: The `FakeGitHubPort` was enhanced to auto-simulate reply visibility. After `replyToReviewComment` is called, a subsequent `listReviewComments` call includes a reply comment with `inReplyToId` set. Without this, tests would fail because verification would always return 0 matches.

### D5: Comment Dedup via State Machine

**Decision**: Rely on the domain's comment state machine for dedup. Only comments in `pending` state (i.e., `isUnresolved()` returns true) are sent to the agent.

**How it works**:
1. Fetch raw comments from GitHub.
2. Filter out replies (`inReplyToId === undefined` means it's a reviewer comment).
3. For each reviewer comment not yet tracked, create a new `PrReviewComment` in `pending` state.
4. Already-tracked comments are not re-created (idempotent upsert).
5. Filter to `isUnresolved()` (pending only) → these are the unresolved comments.

This ensures FR11: a processed comment is never re-sent to the agent.

### D6: Blocking Threshold

**Decision**: Block a comment when verification fails and `attempts >= 2`. This matches the shell's `COMMENT_BLOCK_THRESHOLD=2`.

**State transition**: `pending → replied` increments `attempts`. If verification fails and `attempts >= 2`, block. Otherwise reset to `pending` for retry.

**Note**: `createPrReviewComment` sets `attempts: 0`. `markReplied` increments to `1`. The use case blocks when `attempts >= 2` (after `markReplied`). This means two full `pending → replied → resetForRetry → pending → replied` cycles before blocking.

### D7: Not Implementing Narrow Interface

**Decision**: The class does NOT implement the narrow `ProcessPrReviewCommentsUseCase` interface from `use-cases.ts`.

**Why**: The class needs PR context (repoFullName, prNumber, cwd, phaseId, pollNumber) that the narrow interface doesn't carry. M6-04 (the scheduler) bridges the narrow interface to this class by looking up the Run's PR and worktree details from the repository.

## Implementation Details

### Core Processing Flow

1. **Capture start time** via `deps.now()`.
2. **Fetch + ingest comments**: `github.listReviewComments()` → filter out replies → upsert new comments as `pending`.
3. **Filter to unresolved**: `prReviewRepo.listComments().filter(isUnresolved)`.
4. **Short-circuit if none**: Record `all_resolved` poll attempt, return `NO_UNRESOLVED`. Also verify any orphaned `replied` comments that haven't been verified yet.
5. **Prepare for agent invocation**: Get PR details (branch name), compute diff, render prompt, capture `startCommitSha`.
6. **Invoke agent**: `agent.invoke()` with profile, prompt, expected artifacts.
7. **Extract result**: `extractResult()` — if failed, record `failed` poll attempt, return `BLOCKED` with zero replies.
8. **Per-comment processing loop**:
   - Skip comments not in tracking or already `processed`.
   - `blocked` action → `blockComment()`, increment blocked count.
   - Post reply via `github.replyToReviewComment()`.
   - Record reply via `prReviewRepo.insertReply()`.
   - Batch verification: For all comments, verify commit pushed + build passes (once for all `fixed` comments).
   - Re-fetch comments to verify reply visible.
   - If all verifications pass → `markProcessed()` + `resolveReviewThread()`.
   - If verification fails and `attempts >= 2` → `blockComment()`.
   - If verification fails and `attempts < 2` → `resetForRetry()`.
9. **Record poll attempt** with counts and terminal state.
10. **Return output** with outcome, processed/blocked counts, and `allResolved` flag.

### Orphaned Comment Verification

When there are no unresolved comments, the use case checks for orphaned comments that are in `replied` state but haven't been verified yet. This handles edge cases where a previous pass replied but crashed before verification.

### Batch Verification Optimization

The implementation batches verification: `verifyCommitPushed` and `verifyBuildPasses` are called once for all `fixed` comments, not per-comment. This is efficient because these operations check the repository state, not individual comments.

## Gotchas and Pitfalls

1. **`FakeGitHubPort` reply simulation**: The existing fake records `repliesPosted` but does NOT auto-add reply comments to the `comments` map. Tests will fail if this isn't fixed. The solution was to enhance `replyToReviewComment` to auto-add the reply comment with `inReplyToId` set.

2. **`AgentInvocationRequest.startCommitSha` is required**: The use case must call `git.headCommitSha()` before invoking the agent. Missing this causes a TypeScript compile error.

3. **`attempts` accounting for blocking**: Off-by-one errors are easy here. `createPrReviewComment` sets `attempts: 0`. `markReplied` increments to `1`. The use case blocks when `attempts >= 2` (after `markReplied`). Test in Task 4 validates this.

4. **`diff` base reference**: Hardcoded `origin/HEAD` may not match all PRs. Acceptable for M6-03; M6-04 can pass the correct base.

5. **`EventBusPort.publish` signature**: Takes two arguments `(runUuid: string, event: OrchestratorEvent)`. The test stub must match this.

6. **Reply ID generation**: The use case uses `idFactory()` to generate reply IDs for `prReviewRepo.insertReply()`. The actual GitHub reply ID is obtained from the re-fetched comments (via `githubReply?.id`). If the fake doesn't generate proper IDs, tests may fail.

## What to Know When Modifying This Code

### Key Files
- `packages/application/src/pr-review/process-pr-review-comments.ts` — the use case class
- `packages/application/src/results/schemas/post-pr-review.ts` — the result schema
- `packages/application/src/pr-review/__tests__/process-pr-review-comments.test.ts` — comprehensive tests

### Dependencies Flow
The use case depends only on ports and injected functions:
- `GitHubPort` — for comment fetching, reply posting, thread resolution
- `GitPort` — for diff computation and commit SHA capture
- `AgentPort` — for invoking the post-pr-review agent
- `PrReviewRepositoryPort` — for comment state persistence
- Injected functions: `renderPrompt`, `extractResult`, `verifyCommitPushed`, `verifyBuildPasses`, `resolveProfileForPhase`

### State Machine Transitions
The domain's comment state machine handles transitions:
- `createPrReviewComment` → `pending`
- `markReplied` → `replied` (increments `attempts`)
- `markProcessed` → `processed`
- `resetForRetry` → `pending`
- `blockComment` → `blocked`

### Testing Patterns
Tests use the `makeDeps()` helper to create a controlled environment. Key patterns:
- Override `extractResult` to simulate different agent outcomes
- Override `verifyBuildPasses` to simulate build failures
- Manually seed comments in `repo` to test dedup/blocking
- Verify both the output and the side effects (replies posted, threads resolved, comment states)

### Layer Boundaries
This code lives in `packages/application` and must NOT import from `@ai-sdlc/infrastructure`. All infrastructure wiring happens in `apps/api/src/compose.ts`.

### Future Considerations
- M6-04 will wire this use case into the scheduler and provide the real adapters
- M6-07 will handle reactivation on new review activity
- The `maxIterations` dep is carried for M6-04's convenience but not consumed by this use case
- The hardcoded `origin/HEAD` diff base may need to be configurable in the future