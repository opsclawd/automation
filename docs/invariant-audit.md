# Domain Invariant Audit — PRD §12

**Audit date:** 2026-06-30
**Auditor:** manual — M8-14a
**Scope:** all 18 PRD §12 invariants (0a–0f, 1–12)
**Legend:** `covered` = at least one test would go red if the guard were removed. `GAP` = enforcement exists or is implied by flow but no test catches a violation directly.

---

## Group 0 — Repo / Job / Worker / Lease

### 0a — Run may only start against an approved/registered Repository

**Invariant:** A Run may only start against an approved/registered Repository → `RepositoryNotApprovedError` (M3-02).

**Enforcement:** `packages/infrastructure/src/sqlite/job-queue-repository.ts:110` — `enqueue()` reads the `singleRepo` binding passed at construction; throws `RepositoryNotApprovedError` when the job's `repoId` does not match the approved repository.

**Test:** `packages/infrastructure/src/sqlite/__tests__/job-queue-repository.test.ts:84` — `'enqueue: throws RepositoryNotApprovedError when repository is missing or disabled'`

**Status:** `covered`

---

### 0b — Only one active Run per (Repository, Issue)

**Invariant:** Only one active Run per (Repository, Issue) (M1-03/M3-01).

**Enforcement:** `packages/infrastructure/src/sqlite/run-repository.ts:68` — `insertIfNoActive()` runs a serialised transaction: SELECT for any run whose `issue_number` matches and whose status is not terminal; throws if one exists.

**Gap:** The query filters by `issue_number` only, not by `(repoId, issueNumber)`. The PRD invariant is scoped to a (Repository, Issue) pair, but the implementation is scoped globally to issue number — meaning two runs for issue `#1` in _different_ repositories would incorrectly block each other, and no test exercises the cross-repo boundary. In the current single-repo deployment this cannot manifest, but the enforcement does not match the invariant as written.

**Test:** `packages/application/src/__tests__/start-issue-run.test.ts:256` — `'refuses to start a second active run for the same issue'` (same-repo only)

**Status:** `GAP` — fix `insertIfNoActive` to scope the uniqueness check to `(repoId, issueNumber)` and add a test asserting that two runs for the same issue in different repositories are permitted.

---

### 0c — Only one active WorkerLease per Repository

**Invariant:** Only one active WorkerLease per Repository (M3-04).

**Enforcement (DB):** `packages/infrastructure/src/sqlite/migrations/0013-add-worker-leases.ts:4` — `repo_id TEXT PRIMARY KEY` enforces uniqueness at the SQLite level.

**Enforcement (app):** `packages/infrastructure/src/sqlite/worker-lease-repository.ts:40` — `acquire()` uses an `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= now` pattern; a live (unexpired) lease blocks the upsert and surfaces `WorkerLeaseConflictError`.

**Test:** `packages/application/src/executor/__tests__/worker-loop.test.ts:247` — `'WorkerLeaseConflictError caught: worker skips job without crashing'`

**Status:** `covered`

---

### 0d — Worker must acquire lease before preparing worktree or executing any phase

**Invariant:** A Worker must acquire the lease before preparing a worktree or executing any phase (M8-10).

**Enforcement:** `packages/application/src/executor/worker-loop.ts:84` — `leases.acquire()` is called before `prepareWorktree` or `executeRun` in the tick body. If it throws `WorkerLeaseConflictError` the tick aborts before either call.

**Test:** None. The ordering is verified by code inspection (acquire at line 84, prepareWorktree/executeRun later in the same function) but no test would fail if the two were swapped.

**Status:** `GAP` — add a test that asserts `prepareWorktree` is never called when `acquire` has not first succeeded (e.g. verify prepare is not called when a conflicting lease exists).

---

### 0e — Multiple Workers may run different Repositories concurrently

**Invariant:** Multiple Workers may run different Repositories concurrently (M3-04/M8-10).

**Enforcement:** Architecture — the lease is keyed per repo, so two workers holding leases on different repos can both reach `executeRun` simultaneously.

**Test:** `packages/application/src/executor/__tests__/worker-loop.test.ts:122` — `'two queued jobs on different repos: both run concurrently'`

**Status:** `covered`

---

### 0f — Manual start enqueues a Job; the API never executes inline

**Invariant:** Manual start enqueues a Job; the API never executes inline (M3-03/M8-12).

**Enforcement:** Not yet implemented. `apps/api/src/cli.ts:306` (the `serve` command's `/run` handler) calls `c.runExecutor.execute()` directly — this is the Option-A direct path shipped in #446 to unblock M8-11. The Job-queue re-routing is the subject of #450.

**Test:** None.

**Status:** `GAP` — blocked on #450 (worker-pool / SQLite job queue). Once #450 lands, add a test asserting that the `/run` handler writes a Job row and returns without calling `RunExecutor.execute` on the request path.

---

## Group 1–5 — Run / Phase / Step / Agent-contract

### 1 — A Run cannot be `passed` if any required phase failed

**Invariant:** A Run cannot be `passed` if any required phase failed.

**Enforcement:** `packages/application/src/executor/run-executor.ts:396` — `passRun()` is only called at the point labelled "All phases passed"; any phase failure routes to `failRun` / `blockRun` / early return before that line is reached. `passRun()` itself (`packages/domain/src/run.ts:107`) only checks `currentPhase` is unset and run is not already terminal — it does not re-validate phase outcomes.

**Test:** No test directly verifies that `passRun` cannot be reached when a phase has failed. The protection is by executor flow control, not by a domain assertion that could be independently exercised.

**Status:** `GAP` — add a test that confirms a run with a failed phase record cannot be set to `passed` (either by asserting `passRun` throws, or by verifying the executor always routes failed-phase runs to `failRun`).

---

### 2 — A phase cannot complete without recording a structured result

**Invariant:** A phase cannot complete without recording a structured result.

**Enforcement:** `packages/application/src/executor/run-executor.ts:266–329` — every completion branch (success, failure, blocked, needs_human_review) calls `phaseRepository.update(phase)` before returning. Phase handlers are typed to return `PhaseResult` which the executor unpacks; there is no code path that skips the update.

**Test:** `packages/application/src/executor/__tests__/` covers the executor flow; individual handler tests cover result emission. The coverage is via the handler contract rather than a single "result always written" assertion.

**Status:** `covered` (by flow; a dedicated "no silent completion" test would strengthen this)

---

### 3 — Agent phase with required artifacts fails with `missing_artifact` if artifacts missing

**Invariant:** Agent phase with required artifacts fails if artifacts missing → `missing_artifact` (M4-04/M8 handlers).

**Enforcement:** `packages/application/src/phases/handlers/run-single-shot-agent-phase.ts:146,167` and `packages/application/src/executor/run-executor.ts:581,613` catch `ArtifactNotFoundError` and surface `missing_artifact` failure kind.

**Test:** `packages/application/src/__tests__/render-prompt.test.ts:66,70` covers `ArtifactNotFoundError` propagation. Handler-level `missing_artifact` paths are exercised in `implement.test.ts`.

**Status:** `covered`

---

### 4 — Invalid result value → `invalid_result`

**Invariant:** Invalid result value → `invalid_result` (M4-05).

**Enforcement:** `packages/application/src/phases/handlers/run-single-shot-agent-phase.ts:331`, `packages/application/src/phases/handlers/implement.ts:68,77,92` — schema parse failures and contract violations map to `invalid_result` failure kind.

**Test:** `packages/application/src/phases/handlers/__tests__/implement.test.ts` covers the invalid-result paths.

**Status:** `covered`

---

### 5 — Agent branch change blocks auto-continuation → `branch_changed`

**Invariant:** Agent branch change blocks auto-continuation → `branch_changed` (M4-04, Q20).

**Enforcement:** `packages/application/src/agent/validate-agent-contract.ts:65,70,74` — checks `currentBranch !== expectedBranch` and HEAD SHA drift; pushes `BRANCH_CHANGED` violation code.

**Test:** `packages/application/src/__tests__/validate-agent-contract.test.ts:101` — `'returns branch_changed when branch name differs from expected'` and `:139` — SHA drift case.

**Status:** `covered`

---

## Group 6–12 — PR-review / Validation / Loop / Recovery

### 6 — A PR review comment cannot be processed twice unless explicitly retried

**Invariant:** A PR review comment cannot be processed twice unless explicitly retried (M6).

**Enforcement:** `packages/application/src/pr-review/process-pr-review-comments.ts:115` — filters the comment list with `isUnresolved(c)` (`packages/domain/src/pr-review.ts:167`), which returns `true` only for `state === 'pending'`. After processing, `markProcessed` transitions the comment to `processed`; it cannot return to `pending` except via explicit `resetForRetry`.

**Test:** `packages/application/src/pr-review/__tests__/process-pr-review-comments.test.ts:187` — `'does not invoke the agent when the only comment is already processed'` and `:223` — `'skips already-processed comments in the apply loop'`.

**Status:** `covered`

---

### 7 — A PR review run cannot mark a comment replied without recording the reply attempt

**Invariant:** A PR review run cannot mark a comment replied without recording the reply attempt (M6).

**Enforcement:** `packages/application/src/pr-review/poll-task-runner.ts` — in both the `no_fix` and `fixed` paths, the task runner calls `insertReply()` to write the reply record first, then invokes the domain's `markReplied()` to transition the comment's status, and finally calls `upsertComment()` to persist the comment state.

**Test:** `packages/application/src/pr-review/__tests__/poll-task-runner-reply-order.test.ts` — asserts that `insertReply()` is executed prior to `upsertComment(replied)` for both `no_fix` and `fixed` outcomes.

**Status:** `covered`

---

### 8 — A validation phase records each command result

**Invariant:** A validation phase records each command result (M5).

**Enforcement:** `packages/application/src/run-validation.ts` — maps all command results to `ValidationCommandRecord[]` and persists the whole `ValidationRun` including every command outcome via `validationRunRepository.insert`.

**Test:** `packages/application/src/__tests__/run-validation.test.ts` covers the full command-to-record path, and `packages/infrastructure/src/validation/__tests__/validation-adapter.test.ts` verifies validation execution and record generation at the adapter layer.

**Status:** `covered`

---

### 9 — Max-loop-reached → `needs_human_review` or `failed`, never silent continue

**Invariant:** Max-loop-reached → `needs_human_review` or `failed`, never silent continue (Q8, M7/M8-04/M8-06).

**Enforcement:** `packages/application/src/implement-step/implement-step-loop.ts` and `packages/application/src/review-fix/review-fix-loop.ts` — every exhausted-iterations branch returns `{ outcome: 'needs_human_review' }` or failure, preventing silent continuation.

**Test:** `packages/application/src/implement-step/__tests__/implement-step-loop.test.ts` (asserts `needs_human_review` outcome on loop iteration exhaustion) and `packages/application/src/review-fix/__tests__/review-fix-loop.test.ts` (asserts exhaustion behavior).

**Status:** `covered`

---

### 10 — A Run retains enough artifacts to diagnose the latest failure (NFR2)

**Invariant:** A Run retains enough artifacts to diagnose the latest failure (NFR2).

**Enforcement:**

- **Validation failures:** `packages/application/src/phases/handlers/validate.ts` ensures that `validate/failure.json` is written, preserving the stdout/stderr path logs (e.g., `validate/0-build.stdout.log`, `validate/0-build.stderr.log`) and `validate/validation-result.json`.
- **PR-review:** `packages/application/src/pr-review/process-pr-review-comments.ts` and `packages/application/src/pr-review/poll-task-runner.ts` ensure blocked/retry state and the poll terminal state are persisted.
- **Loop exhaustion:** Implement-step and review-fix loops write explicit terminal status and return a `needs_human_review` or failure outcome to prevent silent execution loss.

**Test:**

- `packages/application/src/phases/handlers/__tests__/validate.test.ts` (asserts `validate/failure.json` contains stdout/stderr log paths and `validation-result.json`).
- `packages/application/src/pr-review/__tests__/process-pr-review-comments.test.ts` (asserts poll records and states).
- Loop exhaustion tests (assert `needs_human_review` outputs on max-loop).

**Status:** `covered`

---

### 11 — Unsafe retries require explicit user confirmation

**Invariant:** Unsafe retries require explicit user confirmation (M8-12).

**Enforcement (flag):** `packages/application/src/run-recovery-actions.ts` — computes `requiresConfirmation: true` when `retrySafety === 'unsafe'`.

**Enforcement (gate):** `apps/api/src/cli.ts` uses `planRunRecoveryAction()` to verify if a resume/retry requires confirmation. If confirmation is required and the `--confirm` flag is missing, the command exits with an error before lease acquisition or phase execution. The REST recovery routes (`apps/api/src/serve.ts`) also enforce confirmation constraints.

**Test:** `apps/api/src/__tests__/runs-recovery-routes.test.ts` (covers REST API recovery route confirmation checks) and `apps/api/src/__tests__/cli-runs-resume-confirmation.test.ts` (covers CLI retry/resume confirmation checks).

**Status:** `covered`

---

### 12 — A managed PR-review poll job records poll count, next poll time, and terminal state

**Invariant:** A managed PR-review poll job records poll count, next poll time, and terminal state (M6-04).

**Enforcement:** `packages/application/src/pr-review/process-pr-review-comments.ts` — `recordPoll()` is called on every exit path to record the poll count (`pollNumber`), comments fetched/processed, and optional terminal state. The `nextPollAt` scheduling is owned and written separately by `PrReviewPoller` when scheduling the next poll attempt.

**Test:** `packages/application/src/pr-review/__tests__/process-pr-review-comments.test.ts` covers the `recordPoll` calls and state transitions on various exit paths.

**Status:** `covered`

---

## Summary

| Invariant                                 | Status                    |
| ----------------------------------------- | ------------------------- |
| 0a — repo approved on enqueue             | `covered`                 |
| 0b — one active run per (repo, issue)     | **GAP**                   |
| 0c — one lease per repo                   | `covered`                 |
| 0d — lease before worktree/exec           | **GAP**                   |
| 0e — concurrent different-repo workers    | `covered`                 |
| 0f — start enqueues, no inline exec       | **GAP** (blocked on #450) |
| 1 — no pass with failed phase             | **GAP**                   |
| 2 — phase always records result           | `covered`                 |
| 3 — missing artifact → `missing_artifact` | `covered`                 |
| 4 — invalid result → `invalid_result`     | `covered`                 |
| 5 — branch changed → `branch_changed`     | `covered`                 |
| 6 — no double comment processing          | `covered`                 |
| 7 — reply recorded before replied state   | `covered`                 |
| 8 — validation records each command       | `covered`                 |
| 9 — max-loop → needs_human_review         | `covered`                 |
| 10 — artifacts for failure diagnosis      | `covered`                 |
| 11 — unsafe retry requires confirmation   | `covered`                 |
| 12 — poll records count/terminal state    | `covered`                 |

**GAPs: 4** → assigned to sub-issues:

- **#395 (14b — 0a–0f):** 0b (repo-scoped uniqueness), 0d (lease ordering), 0f (blocked on #450)
- **#396 (14c — 1–5):** 1 (passRun phase check)
