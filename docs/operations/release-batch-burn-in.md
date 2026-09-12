# Release Batch Burn-In Runbook

This runbook guides operators through testing and burning in the Release Batch orchestration subsystem (`releases` / `release-batch` CLI), validating system stability, failure recovery, candidate verification, and promotion under progressive real-world load.

---

## 1. Overview & Architecture Reference

Release Batch coordinates sequential issue delivery within an isolated release branch (`release/<batchId>`), followed by deterministic candidate commit SHA verification, human testing approval, and atomic promotion to the target source branch (`main`).

```text
Item 1 (Run -> PR -> Merge)
  -> Maintenance Barrier
Item 2 (Fresh Base -> Run -> PR -> Merge)
  -> Maintenance Barrier
Item N (Fresh Base -> Run -> PR -> Merge)
  -> Candidate SHA Locked (awaiting_manual_test)
  -> Manual Approval (approved)
  -> Atomic Promotion PR (main <- release/<batchId>)
  -> Promotion Merged (completed)
```

### Core Operator Rules
1. **Never bypass Run recovery separation:** Run-owned failures (`run_failed`, `run_blocked`, `run_cancelled`, `needs_human_review`) must always be recovered via `runs resume --uuid <runUuid>`. The batch coordinator retains the Run UUID and automatically resumes succession once the Run succeeds.
2. **Exact Candidate SHA Invariant:** Candidate approval is locked to the specific commit SHA tested. Any unexpected commit on the release branch or upstream movement of the source branch invalidates approval (`approval_stale` / blocked) and requires re-testing.
3. **Sequential lazy admission:** At most one batch item owns a Run/Job at any given moment. Successors branch from the fresh remote merge SHA of their predecessor.

---

## 2. Staged Progression Plan

Burn-in follows a 3-tier staged progression. Each stage must satisfy its completion and stability criteria before advancing to the next tier.

| Stage | Batch Size | Target Repositories | Focus Areas | Exit Gate |
| :--- | :--- | :--- | :--- | :--- |
| **Stage 1: Basic Burn-In** | 3 issues | Low-churn internal tool / test repo | Happy path, basic PR merging, maintenance cleanup, candidate approval & promotion | 2 consecutive 3-issue batches succeed with 0 unhandled coordinator errors |
| **Stage 2: Recovery & Drift** | 5 issues | Active development repo | Induced Run failure, manual test rejection, remediation issue appending, source branch drift integration | 2 consecutive 5-issue batches succeed with at least 1 verified recovery and 1 drift integration |
| **Stage 3: Full Production** | 10 issues | Production repo | Extended inter-item maintenance, disk/memory health gates, concurrent supervisor restarts, candidate promotion | 1 full 10-issue batch completes with full audit trail and zero duplicate Runs |

---

## 3. Step-by-Step Operator Workflow

### Step 1: Pre-Flight Checks
Confirm local daemon and target repo are healthy:
```bash
# Verify API service is running
curl -s http://127.0.0.1:4319/healthz || echo "API offline"

# Verify repository is registered and enabled
pnpm --filter @ai-sdlc/api dev repo inspect --full-name <owner/repo>

# Verify GitHub CLI authentication
gh auth status
```

### Step 2: Start the Release Batch
```bash
pnpm --filter @ai-sdlc/api dev releases start \
  --repo-id <repoId> \
  --issues 101,102,103 \
  --source-branch main
```
*Note the returned Batch ID (`batch-<timestamp>-<hash>` or custom ID).*

### Step 3: Monitor Batch Progress
Inspect batch status periodically or pipe to continuous watching:
```bash
# Formatted operator view
pnpm --filter @ai-sdlc/api dev releases status -i <batchId>

# Machine-readable JSON output
pnpm --filter @ai-sdlc/api dev releases status -i <batchId> --json
```

Key fields to check:
- `Current Position`: Position of currently executing issue.
- `Item Status`: `pending` -> `active` -> `waiting_merge` -> `merged`.
- `Blocker`: If present, inspect `Blocker Owner`, `Run Phase`, and `Suggested Command`.

### Step 4: Handle Run-Owned Interventions
If `releases status` reports a Run-owned blocker:
```text
Blocker Owner:     Run (run_failed / needs_human_review)
Run UUID:          550e8400-e29b-41d4-a716-446655440000
Suggested Command: pnpm dev runs resume --uuid 550e8400-e29b-41d4-a716-446655440000
```
Resume the Run directly:
```bash
pnpm --filter @ai-sdlc/api dev runs resume --uuid <runUuid>
```
The batch automatically continues when the Run completes and merges its PR.

### Step 5: Candidate Verification & Approval
When all items merge, the batch transitions to `awaiting_manual_test` and locks `candidateSha`:
```bash
pnpm --filter @ai-sdlc/api dev releases status -i <batchId>
```
1. Fetch and checkout the candidate commit:
   ```bash
   git fetch origin release/<batchId>
   git checkout <candidateSha>
   ```
2. Run manual verification or end-to-end smoke tests.
3. If tests pass, approve candidate:
   ```bash
   pnpm --filter @ai-sdlc/api dev releases approve -i <batchId> --candidate-sha <candidateSha>
   ```
4. If testing fails, reject and remediate:
   ```bash
   pnpm --filter @ai-sdlc/api dev releases reject -i <batchId> --reason "Smoke test failure in checkout module"
   pnpm --filter @ai-sdlc/api dev releases add-issues -i <batchId> --issues 104
   ```

### Step 6: Promotion & Completion
After candidate approval, promote to source branch:
```bash
pnpm --filter @ai-sdlc/api dev releases promote -i <batchId>
```
The coordinator opens a promotion PR against `main`. Once merged (via GitHub auto-merge or operator merge), the batch status transitions to `completed`.

---

## 4. Failure Modes Checklist & Diagnostic Matrix

| Failure Mode | Symptom / Status | Diagnostic Indicator | Remediation Procedure |
| :--- | :--- | :--- | :--- |
| **Run Failure / Lint Error** | Batch blocked; item marked `blocked` | `blockerOwner: run`, `runStatus: failed` | Check run logs: `pnpm dev runs logs --uuid <runUuid>`. Fix code in worktree or retry phase: `pnpm dev runs resume --uuid <runUuid> --from-phase implement --confirm`. |
| **Needs Human Review** | Batch stops succession; item active/blocked | `blockerOwner: run`, `runStatus: needs_human_review` | Review GitHub PR comments or manual review prompt. Address review items, then run `pnpm dev runs resume --uuid <runUuid>`. |
| **PR Closed Without Merge** | Batch permanently blocked | `blockedReason: pr_closed_without_merge` | Hard stop. PR was closed without merging. Inspect git history. If intended, cancel batch: `pnpm dev releases reject -i <batchId>`. |
| **Source Branch Drift (Pre-Approval)** | Upstream `main` commits added while building | `releases status` shows source branch ahead | Run `pnpm dev releases integrate-source -i <batchId>` to merge source updates into `release/<batchId>`. |
| **Source Branch Drift (Post-Approval)** | Approval invalidated; batch status `blocked` | `blockedReason: source_branch_advanced`, notification: `approval_stale` | Upstream `main` moved after manual testing. Re-integrate source (`releases integrate-source -i <batchId>`), rerun smoke tests, and approve new SHA. |
| **Release Branch Drift** | Candidate SHA mismatch | `blockedReason: release_branch_drift`, notification: `approval_stale` | External commit pushed directly to `release/<batchId>`. Re-verify candidate tree and approve the new HEAD SHA. |
| **Environment Health Gate** | Batch stops before admitting next item | `blockedReason: environment_health_failed` | Inspect disk space (`df -h`) and memory (`free -m`). Clean up dangling containers or tmp files. Batch unblocks automatically on next reconcile. |
| **Process Crash / Restart** | Coordinator process terminates unexpectedly | Database reflects intermediate state | Start API process. Reconcile picks up existing active Run or queues next item idempotently without duplicating Runs. |

---

## 5. Metrics Tracking Table

Operators should record metrics for each completed burn-in batch:

| Run Date | Batch ID | Repo | Stage | Items Admitted | Items Merged | Run Resumes | Drift Integrations | Promotion Latency (min) | Final Status | Operator Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| YYYY-MM-DD | batch-001 | acme/api | Stage 1 | 3 | 3 | 0 | 0 | 4.2 | completed | Clean happy path |
| YYYY-MM-DD | batch-002 | acme/api | Stage 1 | 3 | 3 | 1 | 0 | 6.8 | completed | Resumed item 2 after flake |
| YYYY-MM-DD | batch-003 | acme/web | Stage 2 | 5 | 5 | 2 | 1 | 12.5 | completed | Tested drift integration |
| YYYY-MM-DD | batch-004 | acme/web | Stage 2 | 5 | 5 | 0 | 1 | 8.1 | completed | Stage 2 exit gate met |
| YYYY-MM-DD | batch-005 | acme/api | Stage 3 | 10 | 10 | 1 | 2 | 22.0 | completed | Full 10-issue burn-in |
