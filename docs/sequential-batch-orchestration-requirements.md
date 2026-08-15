# Sequential Batch Orchestration Requirements

**Status:** Scope locked for v1  
**Date:** 2026-08-15  
**Repository:** `opsclawd/automation`

## 1. Purpose

Add a first-class batch coordinator that can execute an explicit ordered list of GitHub issues sequentially with minimal operator intervention:

```text
issue N
  -> Run executes
  -> PR opens
  -> GitHub merge requirements become satisfied
  -> PR merges
  -> inter-issue maintenance runs
  -> next issue is admitted from a fresh base
```

The batch layer must preserve the orchestrator's existing Run, Job, scheduler, WorkerLease, resume, and recovery machinery rather than replacing it with a second execution queue.

The central design decision is **lazy admission**: only the current batch item may own a Run/Job. The next item is not converted into a Run until the current item's PR has actually merged and the inter-issue maintenance barrier has passed.

## 2. Current-system constraints

The implementation must work with the existing architecture rather than bypass it:

- `Run` is the lifecycle record for one issue-to-PR execution.
- `Job` is a schedulable execution attempt for a Run.
- `WorkerLease` enforces one active worker per repository.
- `RunExecutor` owns the canonical phase sequence.
- failed, blocked, needs-human-review, and cancelled Runs are already resumable through the existing `runs resume --uuid ...` flow.
- waiting Runs are non-terminal and are already reconciled by the waiting-run sweeper.
- the current repository reports GitHub auto-merge as disabled; enabling it is an operational prerequisite for the v1 merge-gated flow.
- the repository already has open issue #694 for built-in orphaned vitest/test-runner reaping. Batch maintenance must reuse that work rather than implement a competing orphan-process subsystem.

## 3. Goals

V1 must provide all of the following:

1. Start a batch from an explicit ordered issue list for one registered repository.
2. Admit exactly one batch item at a time.
3. Preserve the same Run UUID across ordinary run failures and human-review blockers.
4. Stop batch advancement whenever the current Run requires intervention.
5. Continue automatically when that same Run is resumed and later succeeds.
6. Treat PR merge, not PR creation, as the completion boundary for a batch item.
7. Use GitHub's merge requirements and auto-merge as the authoritative merge gate rather than duplicating branch-protection logic in the orchestrator.
8. Run deterministic inter-issue machine/repository maintenance before admitting the next issue.
9. Branch every subsequent issue from a freshly fetched remote base after the predecessor has merged.
10. Recover safely after process restart without duplicating Runs or advancing the batch twice.
11. Expose batch status and actionable blocker information through the CLI.

## 4. Explicit non-goals

The following are out of scope for v1:

- parallel execution of items inside one batch;
- dependency DAGs between issues;
- multi-repository batches;
- milestone/label/query-based issue discovery;
- automatically reordering the supplied issue list;
- `continueOnFailure` behavior;
- automatically skipping a failed item;
- a batch-level skip command;
- replacing `runs resume` with a new recovery mechanism;
- automatic code fixes for a red post-PR CI run;
- a custom CI polling-and-merge engine that bypasses GitHub merge requirements;
- removing the existing explicit/manual PR-review-comment tooling;
- worker/API process recycling between every issue;
- a new cross-platform process supervisor beyond the orphan-reaping work already tracked by #694;
- reserving an entire repository exclusively for the lifetime of a batch. Existing scheduler/lease rules remain authoritative for repository concurrency.

## 5. Terminology

### Batch

A persisted orchestration record containing one ordered list of issue numbers for one repository.

### BatchItem

One position in a Batch. A BatchItem eventually references exactly one Run UUID and, after PR creation, one PR number.

### Admission

The act of creating the Run and initial Job for a BatchItem. Admission occurs lazily and only for the current item.

### Run blocker

A recoverable state owned by the Run lifecycle, such as `failed`, `blocked`, `needs_human_review`, or a Run that was cancelled outside the Batch flow.

### Batch blocker

A condition outside the Run's normal resume lifecycle, such as an unhealthy execution environment, unavailable auto-merge configuration, a closed-without-merge PR, or failed merge requirements.

### Inter-issue maintenance barrier

The deterministic maintenance and freshness checks that run after an item merges and before the next item is admitted.

## 6. Core invariants

These invariants are load-bearing and must have tests.

### INV-1: One admitted BatchItem

For a Batch, at most one non-merged BatchItem may have a `runUuid`.

```text
#101 active      -> has Run
#102 pending     -> no Run
#103 pending     -> no Run
```

The system must never pre-create Runs/Jobs for all batch items.

### INV-2: One Run per BatchItem

A BatchItem may acquire a Run UUID once. Resume/retry operations reuse that Run UUID; they never create a replacement Run for the same item.

### INV-3: No advancement before merge

A Batch cannot advance from item N to N+1 until item N's PR is confirmed merged.

A PR being open, CI being green, or auto-merge being enabled is not sufficient by itself.

### INV-4: Recoverable Run blockers preserve position

`failed`, `blocked`, `needs_human_review`, and externally-cancelled current Runs stop the Batch on the same BatchItem. No later issue may be admitted.

### INV-5: Existing Run resume remains canonical

Resuming a current BatchItem uses the existing Run command and the same UUID:

```bash
pnpm --filter @ai-sdlc/api start runs resume \
  --uuid <run-uuid> \
  --target-repo-root <repo-root> \
  --confirm
```

The BatchCoordinator observes the Run's transition back to `running`; a second batch-specific run-resume operation must not be required.

### INV-6: Job lifetime is not Run lifetime

A Job represents one worker execution attempt. A valid intentional pause or operator gate must not be misclassified as an infrastructure/execution failure merely because the Run has not reached `passed` yet.

### INV-7: Fresh base between items

The next BatchItem must branch from the fetched remote base after the previous PR merge. A stale local `main` or other local base ref must never be the source of the next issue branch.

### INV-8: Advancement is idempotent

Crash/restart or duplicate reconciliation must not create two Runs for one BatchItem or admit two successor items. Advancement must be guarded by persisted state and an atomic/CAS transition.

## 7. Domain model

The exact implementation may follow repository naming conventions, but v1 requires equivalent persisted state.

```ts
interface Batch {
  id: BatchId;
  repoId: RepositoryId;
  baseBranch: string;
  status: 'queued' | 'running' | 'blocked' | 'completed';
  currentPosition: number;
  blockedReason?: BatchBlockedReason;
  createdAt: Date;
  completedAt?: Date;
}

type BatchItemStatus =
  | 'pending'
  | 'active'
  | 'blocked'
  | 'waiting_merge'
  | 'merged';

interface BatchItem {
  batchId: BatchId;
  position: number;
  issueNumber: number;
  status: BatchItemStatus;
  runUuid?: string;
  prNumber?: number;
  mergedCommitSha?: string;
  blockedReason?: BatchBlockedReason;
  startedAt?: Date;
  completedAt?: Date;
}
```

Minimum blocker reasons:

```ts
type BatchBlockedReason =
  | 'run_failed'
  | 'run_blocked'
  | 'needs_human_review'
  | 'run_cancelled'
  | 'ci_failed'
  | 'merge_requirements_blocked'
  | 'pr_closed_without_merge'
  | 'merge_configuration_error'
  | 'environment_unhealthy';
```

A database uniqueness constraint must prevent duplicate `(batchId, position)` records, and the model must make duplicate Run admission for one item impossible or atomically reject it.

## 8. Job execution outcome semantics

The current worker path must be changed so it does not reduce every non-`passed` Run to `Job.failed`.

Introduce an internal worker execution outcome equivalent to:

```ts
type ExecutionOutcome =
  | 'completed'
  | 'deferred'
  | 'operator_blocked'
  | 'failed'
  | 'cancelled';
```

Required mapping:

| Run result after worker execution | ExecutionOutcome | Job terminal state |
| --- | --- | --- |
| `passed` | `completed` | `succeeded` |
| `waiting` | `deferred` | `succeeded` |
| `blocked` | `operator_blocked` | `succeeded` |
| `needs_human_review` | `operator_blocked` | `succeeded` |
| `failed` | `failed` | `failed` |
| `cancelled` | `cancelled` | `cancelled` |

The scheduler must release its WorkerLease/capacity after all of these outcomes.

CLI success/failure must be based on Run state, not merely `Job.succeeded`. In particular, `blocked` and `needs_human_review` must remain visible non-success outcomes to an operator even though the worker attempt itself ended normally.

## 9. Batch creation and lazy admission

### FR-1: Explicit ordered input

Batch start accepts a comma-separated ordered issue list. The provided order is authoritative.

Example:

```bash
pnpm run batch:preflight \
  --issues 101,102,103,104 \
  --target-repo-root /home/gary/.openclaw/workspace/comfy-content-orchestrator
```

V1 does not infer the list from milestones, labels, dependencies, or issue creation dates.

### FR-2: Validate before persistence/admission

Batch start must reject:

- an empty issue list;
- duplicate issue numbers in the same batch;
- an unknown/disabled repository;
- an invalid base branch;
- an issue that cannot be resolved from the target GitHub repository;
- repository conditions that make the existing full preflight fail.

### FR-3: Initial admission

After a successful full preflight:

1. persist Batch + all BatchItems;
2. set item 0 active;
3. create exactly one Run for item 0;
4. create/enqueue exactly one initial Job for that Run;
5. return the Batch ID and current Run UUID.

All later BatchItems remain `pending` with no Run UUID.

## 10. Run blockers and recovery

### FR-4: Failed Run

When the current Run becomes `failed`:

```text
Batch.status = blocked
BatchItem.status = blocked
BatchItem.blockedReason = run_failed
```

No next Run or Job may be created.

After the operator fixes the underlying problem and executes the existing `runs resume --uuid ...` command, the same Run UUID is reactivated and a resume Job is enqueued by the existing `ResumeRun` use case.

The BatchCoordinator must observe that Run becoming `running` and restore:

```text
Batch.status = running
BatchItem.status = active
```

No batch-specific resume command is required for this case.

### FR-5: Needs human review

`needs_human_review` behaves identically to a failed Run from the Batch's perspective, except for `blockedReason = needs_human_review`.

The operator resolves the blocker and uses the existing `runs resume --uuid ...` command.

### FR-6: Run blocked or externally cancelled

A current Run entering `blocked` or `cancelled` outside the BatchCoordinator also blocks the Batch on the current item. The Batch never interprets either state as permission to continue to the next issue.

### FR-7: Repeated blockers

The same Run may move through any number of blocker/resume cycles:

```text
running
-> failed
-> resumed
-> running
-> needs_human_review
-> resumed
-> running
-> PR
-> merged
```

The BatchItem retains the same Run UUID throughout.

## 11. PR completion and merge gate

### FR-8: PR creation is not item completion

After `create-pr`, the Run enters a merge-waiting lifecycle. The item becomes `waiting_merge` and the worker releases its lease/capacity.

### FR-9: GitHub auto-merge is the v1 merge mechanism

The orchestrator must request GitHub auto-merge after PR creation. GitHub branch protection, required status checks, required approvals, and other configured merge requirements remain the authoritative gate.

The orchestrator must not implement a second policy engine that decides it can merge despite GitHub's configured requirements.

Default merge method for v1 should be `squash` unless repository configuration explicitly selects another method.

### FR-10: Auto-merge capability validation

If repository auto-merge is disabled or unavailable, the current item and Batch become blocked with `merge_configuration_error` and an actionable message.

The application must not silently fall back to bypassing merge requirements.

Operational prerequisite for this repository: GitHub auto-merge must be enabled at the repository level before the feature is considered production-ready.

### FR-11: Merge-state reconciliation

The waiting/reconciliation path must distinguish at least:

| External state | Run | BatchItem | Batch |
| --- | --- | --- | --- |
| PR open, checks pending | `waiting` | `waiting_merge` | `running` |
| PR open, checks failed | `waiting` | `blocked(ci_failed)` | `blocked` |
| PR open, other required merge gate unmet | `waiting` | waiting/blocked with actionable reason | running/blocked as appropriate |
| PR merged | `passed` | `merged` | advance or complete |
| PR closed without merge | `cancelled` or equivalent non-success terminal representation | `blocked(pr_closed_without_merge)` | `blocked` |

A red CI result does not cause the orchestrator to invent an automatic code fix in v1. A human or external actor may push a correction to the PR branch; reconciliation must then observe the new check state and continue when merge requirements recover.

### FR-12: Existing PR-review-comment tooling remains separate

The canonical Batch issue-to-PR completion path no longer depends on review bots leaving comments. Existing explicit/manual PR-review-comment use cases may remain available but are not a prerequisite for Batch completion and are not removed as part of this feature.

## 12. Batch advancement

### FR-13: Advance only from a confirmed merged current item

`advanceBatch(batchId)` must be idempotent and transactionally guarded.

Conceptually:

```ts
if (batch.status !== 'running') return;

const current = currentBatchItem(batch);
if (!current || current.status !== 'merged') return;

if (current is final item) {
  markBatchCompleted();
  return;
}

runInterIssueMaintenance();
resolveFreshRemoteBase();
admitExactlyOneNextItem();
```

If the process crashes at any point, restart/reconciliation must continue from persisted state without admitting the next item twice.

## 13. Inter-issue maintenance barrier

The full operator-facing `preflight.sh` runs once at Batch start. It must **not** be recursively rerun wholesale between items.

Instead, after item N merges and before item N+1 is admitted, the BatchCoordinator invokes a reusable deterministic maintenance barrier.

### FR-14: Process cleanup

The barrier must invoke the built-in orphan/test-runner cleanup from issue #694 once that work exists. Do not duplicate the PPID-1 vitest detection implementation in a Batch-specific subsystem.

If the runtime already exposes ownership of child process groups for the completed Run, lingering Run-owned children must be terminated/reaped before the next item. Building a brand-new general process supervisor is out of scope.

### FR-15: Temporary-file cleanup

Reuse the same stale test-fixture cleanup policy as preflight: known leaked temp prefixes older than the safe age threshold are removed, and regenerable temp caches may be cleared.

### FR-16: Disk health gate

`/tmp` free space must be checked before next admission. Preserve the current preflight safety floor of 2048 MB unless a central configuration replaces it.

If the threshold is not met:

```text
Batch.status = blocked
Batch.blockedReason = environment_unhealthy
```

No successor Run is admitted.

### FR-17: Memory health gate

After process/temp cleanup, record host memory state using a deterministic OS metric such as Linux `MemAvailable`.

V1 must support a configurable minimum available-memory threshold. A default around 4096 MB is acceptable for the current deployment, but the implementation must make the threshold explicit and testable rather than burying it in shell output.

If the threshold is not met, the Batch blocks with `environment_unhealthy` and exposes the measured value.

### FR-18: Worktree cleanup

The completed item's worktree must be removed or otherwise released according to existing worktree lifecycle rules before successor admission. Run artifacts stored outside the worktree remain available.

### FR-19: Worker process recycling is not required

V1 does not restart the API/worker process between every issue. If measurements later show monotonic heap growth in the long-lived orchestrator process itself, worker recycling becomes a separate follow-up.

## 14. Fresh-base safety

### FR-20: Fetch after merge

After the current PR is confirmed merged and maintenance succeeds:

```text
git fetch origin <baseBranch>
```

must occur before the next Run/worktree is created.

### FR-21: Separate PR base from worktree source

The PR target remains the logical branch name such as `main`, but the worktree/feature branch source must resolve from the freshly fetched remote ref or its exact SHA.

Conceptually:

```text
prBaseBranch      = main
worktreeBaseRef   = origin/main
worktreeBaseSha   = <freshly resolved SHA>
```

The implementation must not create the next worktree from a stale local `main` merely because `main` exists locally.

### FR-22: Persist/observe base SHA

The successor Run or BatchItem should record the base commit SHA used for admission so debugging can prove that item N+1 started after item N's merge.

## 15. Persistence and restart recovery

### FR-23: Persist all Batch state

Batch and BatchItem state must live in SQLite through application ports/adapters consistent with the repository architecture.

### FR-24: Reconcile on startup/periodic sweep

A reconciliation use case must be able to reconstruct what to do from persisted state:

- active Run queued/running -> leave current item active;
- Run waiting on PR -> reconcile PR/check/merge state;
- Run failed/blocked/needs-human-review/cancelled -> block Batch;
- current item merged but next item not admitted -> run maintenance and admit next exactly once;
- final item merged -> complete Batch;
- inconsistent impossible state -> block with explicit diagnostic rather than guessing.

### FR-25: No duplicate admission after crash

A crash between BatchItem transition and Job enqueue must be recoverable without creating a second Run for the same item. Use unique constraints, CAS, transaction boundaries, or equivalent idempotency keys.

## 16. CLI requirements

### FR-26: Initial batch command

The normal operator entry point becomes:

```bash
pnpm run batch:preflight \
  --issues 101,102,103,104 \
  --target-repo-root /home/gary/.openclaw/workspace/comfy-content-orchestrator
```

The existing single-issue flow remains supported:

```bash
pnpm run run:preflight \
  --issue 101 \
  --target-repo-root /home/gary/.openclaw/workspace/comfy-content-orchestrator
```

### FR-27: Batch status

Provide a CLI equivalent to:

```bash
pnpm --filter @ai-sdlc/api start batches status \
  --id <batch-id> \
  --target-repo-root <repo-root>
```

Status output must show:

- Batch ID and status;
- ordered issue list;
- current item;
- current Run UUID;
- current phase when available;
- PR number when available;
- blocker reason and failure reason when blocked;
- merged/pending state for every item.

### FR-28: Existing Run resume command remains unchanged

For Run-owned blockers, operators continue using:

```bash
pnpm --filter @ai-sdlc/api start runs resume \
  --uuid <run-uuid> \
  --target-repo-root <repo-root> \
  --confirm
```

Once the Run returns to `running`, Batch reconciliation must restore the Batch automatically.

### FR-29: Batch-level resume/reconcile command

Provide a narrow Batch command for Batch-owned blockers, equivalent to:

```bash
pnpm --filter @ai-sdlc/api start batches resume \
  --id <batch-id> \
  --target-repo-root <repo-root> \
  --confirm
```

This command reruns Batch reconciliation/maintenance after the operator has corrected an environment or merge-configuration blocker.

It must **not** secretly resume a `failed`/`needs_human_review` Run. If the current blocker belongs to the Run, it must instruct the operator to use `runs resume --uuid ...` instead.

### FR-30: No batch skip/continue command in v1

There is no command that silently advances over a failed current issue. Strict sequencing is intentional because later issues may depend implicitly on the merged state of earlier ones.

## 17. Observability

The Batch feature must emit structured events or equivalent persisted audit data for at least:

- batch created;
- item admitted;
- item blocked;
- item resumed via observed Run transition;
- PR waiting for merge;
- CI/merge requirement blocked;
- PR merged;
- inter-issue maintenance started/completed/blocked;
- fresh base resolved;
- next item admitted;
- batch completed.

Every blocker event must include the Batch ID, issue number, Run UUID when available, and an actionable reason.

## 18. Failure-policy matrix

| Condition | Batch action | Operator action | Automatic continuation |
| --- | --- | --- | --- |
| Run `failed` | block current item | fix + `runs resume` | yes after same Run resumes |
| Run `needs_human_review` | block current item | resolve + `runs resume` | yes |
| Run `blocked` | block current item | resolve + `runs resume` | yes |
| Run externally `cancelled` | block current item | decide whether to resume Run | yes if resumed |
| PR open, checks pending | wait | none | yes |
| PR checks failed | block current item | fix/push externally or otherwise correct | yes when checks recover |
| PR merged | mark item merged | none | yes after maintenance |
| PR closed without merge | block | human decision | no |
| auto-merge unavailable | block | enable/fix GitHub configuration + `batches resume` | yes after reconciliation |
| `/tmp` or memory unhealthy | block | clean host + `batches resume` | yes after maintenance passes |
| maintenance/fetch failure | block | correct environment/repo + `batches resume` | yes |

## 19. Acceptance scenarios

### Scenario A: Four-issue happy path

Given issues `101,102,103,104`, the system:

1. runs full preflight once;
2. creates Run only for #101;
3. opens #101 PR and waits;
4. observes merge;
5. runs maintenance/fresh-base barrier;
6. creates Run for #102;
7. repeats until #104 merges;
8. marks Batch completed;
9. never has Runs for two pending batch items simultaneously.

### Scenario B: Human-review blocker

#102 enters `needs_human_review`.

Expected:

- Batch is blocked on #102;
- #103 has no Run;
- operator fixes the problem and invokes `runs resume` against #102's existing UUID;
- Batch automatically returns to running;
- #102 eventually merges;
- only then is #103 admitted.

### Scenario C: Ordinary Run failure

#101 fails during validate.

Expected:

- Job attempt is failed only if the Run truly failed;
- Batch remains at #101;
- operator resumes the same Run UUID;
- no replacement Run is created;
- the Batch can survive repeated fail/resume cycles.

### Scenario D: Intentional waiting is not Job failure

#101 opens a PR and enters `waiting`.

Expected:

- worker Job finishes successfully/deferred;
- WorkerLease is released;
- Run remains waiting;
- BatchItem is `waiting_merge`;
- scheduler capacity is not held while GitHub CI runs.

### Scenario E: CI failure

#101 PR CI turns red.

Expected:

- Run remains waiting;
- Batch blocks with `ci_failed`;
- no #102 Run exists;
- after a correction is pushed and GitHub requirements recover, reconciliation continues;
- the Batch advances only after the PR actually merges.

### Scenario F: Crash after merge before next admission

The process crashes after #101 is marked merged but before #102's Run is created.

Expected after restart:

- reconciliation sees #101 merged;
- maintenance runs/re-runs idempotently;
- exactly one #102 Run is created;
- no duplicate Run/Job is admitted.

### Scenario G: Environment leak between issues

After #101 merges, orphan/test processes or stale temp directories are present and memory is below threshold.

Expected:

- maintenance invokes reusable cleanup;
- memory/disk are remeasured;
- if still unhealthy, Batch blocks before #102 admission;
- after host cleanup, `batches resume` reruns the barrier;
- #102 starts only when health gates pass.

### Scenario H: Fresh-base proof

#101 merges commit `M` into `main`.

Expected:

- origin/main is fetched after merge;
- #102's recorded base SHA includes `M`/equals the new remote tip at admission;
- #102 never branches from the stale pre-#101 local main SHA.

## 20. Implementation decomposition

The feature should land as small, independently reviewable issues in this order:

1. Normalize worker Job outcomes for waiting and recoverable Run gates.
2. Add Batch/BatchItem domain types, ports, SQLite persistence, and invariants.
3. Implement lazy BatchCoordinator admission, blocker reconciliation, and restart-safe advancement.
4. Add merge-gated issue-to-PR completion using GitHub auto-merge and existing waiting reconciliation.
5. Add inter-issue maintenance and fresh-remote-base admission, reusing #694 orphan-reaping.
6. Add batch preflight/start/status/resume CLI integration plus end-to-end batch scenarios.

Issues may be implemented in parallel only where dependencies permit, but each PR must preserve the invariants in this document.

## 21. Dependency note: issue #694

Issue #694 remains the owner of making orphaned vitest/test-runner reaping built-in and reusable. The Batch maintenance implementation depends on or reuses that facility.

If #694 has not landed when Batch maintenance is implemented, the Batch issue may extract the existing preflight cleanup into a reusable component **only if that work also satisfies/coordinates with #694**. Two separate orphan-reaping implementations must not be left in the repository.

## 22. Definition of done

The v1 feature is complete when an operator can start an explicit multi-issue batch once, leave it unattended through successful items, intervene only when a current Run or external merge gate genuinely requires attention, resume the same Run after intervention, and trust that every successor issue starts only after its predecessor merged and the host/repository passed the inter-issue maintenance barrier.

The system must prove through tests that it does not pre-admit future Runs, does not treat waiting as failure, does not advance past a blocker, does not branch from stale local base state, and does not duplicate admission after restart.
