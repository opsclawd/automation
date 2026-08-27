# ADR-0010: Task Scope Contract, Recoverable Drift, and Worktree Hygiene

**Status:** Accepted  
**Date:** 2026-08-20  
**Supersedes:** N/A — extends ADR-0002 (run lifecycle and resume semantics) and ADR-0005 (worktree reuse and cancellation safety)

## Context

The orchestrator's task boundary enforcement mechanism historically enforced a file-exact contract: each task's `expected_files` was required to predict every file an implementation would touch. Anything outside `expected_files` and `reference_files` was treated as an undeclared violation, triggering hard step failures (`canRetry: false`).

Between 2026-08-16 and 2026-08-20, dozens of orchestrator runs across multiple repositories halted on task boundary violations. Empirical investigation revealed that 75%+ of these halts were false positives caused by incidental, legitimate edits (such as updating sibling tests, package barrel exports, or port fakes) rather than genuine agent overreach. Furthermore:

1. `expected_files` conflated **obligation** (verifying promised deliverables) with **permission** (authorizing directories where changes may occur).
2. The retry mechanism asked the LLM in narrative form to rewrite git commits, leading to claim-vs-reality mismatches where the model claimed files were removed but the git diff retained them (PR #971 / comfy #62).
3. Review probes from `plan-review` left uncommitted untracked files deep inside package subtrees (`apps/web/src/test-mock*.ts`), causing `implement` to fail its inbound cleanliness check.
4. Resuming failed/aborted runs on `orchestrator runs resume` misattributed the step's own incomplete working tree changes to prior phases.

## Decisions

### 1. Split Obligation from Permission in Task Declarations

- **`expected_files` (Obligation only)**: Precise, minimal deliverables promised by the task. The `missingFiles` check at step completion verifies that declared deliverables were committed.
- **`permitted_areas` (Permission only)**: Directory-scoped permission. Defaults to the **immediate parent directory** of each non-root path in `expected_files`. Root-level files (e.g. `package.json`, `README.md`) authorize only that exact file and **never** derive repository-root (`.`) permission.
- **Explicit Path Matching & Precedence**:
  - `permitted_areas`: Directory prefix match (`path === area || path.startsWith(area + '/')`).
  - `may_extend`: Exact normalized path match (`path === mayExtendPath`).
  - `non_goals`: Exact path or directory prefix match.
  - Precedence, as implemented in `classifyTaskChanges` (`packages/application/src/task-file-boundaries.ts`): (1) immutable protected — orchestrator artifacts and `.ai-orchestrator.json`, never declarable away; (2) `non_goals`; (3) current task's `expected_files` (exact); (4) protected system files (`.gitignore`, `.github/**`) when not explicitly in `expected_files` — these are declarable, unlike tier 1; (5) downstream `expected_files` → `premature_implementation`; (6) `reference_files`; (7) current task's `may_extend` (exact); (8) `permitted_areas` for tracked paths — an untracked create under a permitted area is drift, not permission; (9) undeclared untracked → drift.
  - Two deviations from an earlier draft of this ADR, now settled by implementation: `may_extend` sits below downstream `expected_files` and `reference_files` (tiers 7, after 5–6), not co-tiered with `expected_files` at tier 3 — an optional `may_extend` touch yields to a downstream task's declared deliverable or another task's reference file, while an obligatory `expected_files` touch does not. And "protected" is two tiers, not one: orchestrator artifacts (tier 1) can never be declared into scope, while `.gitignore`/`.github/**` (tier 4) can be, by listing them in `expected_files`.
  - `reference_files` overlap with writable declarations (`expected_files`, `may_extend`) within the _same_ task is rejected at manifest-schema validation time (`taskManifestV2Schema`), not resolved by runtime precedence. Tier 6 above governs only reference files declared by a _different_ task in the manifest.
- **Verification / Empty Tasks**: Tasks with `expected_files: []` requiring write access must explicitly declare `permitted_areas`; otherwise they remain read-only.
- **Classifier-Driven Auto-commit**: The step auto-commit consumes the classifier's permitted-paths output directly, committing only files verified as permitted.
- **Manifest Producers & Compatibility**: Manifest authoring prompts (`prompts/plan-write/`) and `task-context-generator.ts` produce and carry these fields. Legacy V1/V2 manifests with `files` map transparently to `expected_files`.

### 2. Generalized Scope Reverter, Stateful Cap, and Deep Scratch Purge

- When an undeclared file modification or drift is detected:
  - The runner invokes `RevertScopeFilesPort`: restores baseline-present files from the current attempt's pre-step baseline (`preStepHead`), removes newly created baseline-absent files (`git rm -rf`), amends the commit with `--no-edit`, and returns `amendedHeadSha`.
  - Reclassification re-runs against both the amended commit diff and dirty worktree.
  - A per-step, normalized-path $\rightarrow$ count map (`revertCounts: Record<string, number>`) is stored via SQLite migration `0034-add-step-revert-counts.ts` (`revert_counts TEXT NOT NULL DEFAULT '{}'`) on `Step`. Cap is $N = 2$ reverts per path across resumes before escalating to `needs_human_review`.
- Deep scratch file remediation sweeps uncommitted untracked probes across all package subdirectories while exempting orchestrator artifacts (`isOrchestratorArtifactPattern`) and declared deliverables (`expected_files` / `may_extend`).

### 3. Premature Implementation Classification

- If a modified file belongs to the `expected_files` of a downstream task in the same manifest ($> \text{currentTask.n}$), the runtime classifies the violation as `premature_implementation`.
- The runner mechanically reverts the file to the baseline via `RevertScopeFilesPort`, reports the owning downstream task, and avoids widening declarations.

### 4. Worktree Lifecycle and Phase-Boundary Hygiene

- **Inbound to `implement`**: Mechanical worktree reset restores tracked dirty files to current `HEAD` and purges untracked probe files.
- **On Run Resume**: `orchestrator runs resume` resets the worktree to `initialPreStepHead`. If `initialPreStepHead` is unresolvable, the engine preserves working tree state and transitions safely to `needs_human_review`.
- **Operator Repair Preservation & Migration 0035**:
  - SQLite migration `0035-add-job-resume-disposition.ts` adds `resume_disposition TEXT` to the `jobs` table, and `Job` in domain supports `resumeDisposition: 'preserve_working_tree' | 'reset_to_baseline'`.
  - Disposition defaults: Ordinary resumes from `failed` or `blocked` default to `reset_to_baseline`. Resumes from `needs_human_review` with uncommitted changes require an explicit disposition (failing fast if omitted).
  - When `preserve_working_tree` is active, working tree diffs are classified using the boundary classifier and preserved across inbound cleanliness checks. Discarded paths are audited via `EventRepository` before reset.

### 5. Plan-Review Invariants for Monorepos

- Structured manifest signals provide targeted, deterministic validation inputs with 1-based task references (`tasks[].n`):
  - `public_symbols?: Array<{ barrel_file: string; symbols: string[] }>`
  - `deferred_exports?: Array<{ symbol: string; barrel_file: string; owning_task: number }>`
  - `planned_package_scripts?: Array<{ package_json: string; scripts: Record<string, string> }>`
  - `task_type?: 'standard' | 'red' | 'implementation' | 'verification'`
  - `paired_with_task?: number`
- **Barrel Exports**: Declared `public_symbols` under `packages/<pkg>/src/<sub>/` must have `barrel_file` in `expected_files` or in `deferred_exports` with a valid downstream `owning_task`.
- **Next.js Intermediate Buildability**: Tasks introducing Next.js build scripts via `planned_package_scripts` (`"build": "next build"`) must co-locate minimal structural entrypoints (`app/layout.tsx` + `app/page.tsx` or `pages/_app.tsx` + `pages/index.tsx`) in `expected_files`.
- **RED Validation Parity**: Red tasks (`task_type: 'red'`) must declare failing commands (`! command`) and cannot share identical validation commands with their paired implementation task.

### 6. Failure Taxonomy & Incident Telemetry

- Domain step statuses in `StepStatus` remain lowercase: `pending`, `running`, `success`, `failed`, `needs_human_review`.
- Repeatable incident telemetry (`step.recovered_scope_violation`, `step.premature_implementation`, `step.task_boundary_blocked`, `step.infrastructure_failure`) is defined in `packages/domain/` and published through a consolidated persisting event-bus decorator in `apps/api/src/compose.ts` to `EventRepository` in SQLite, exposed via existing `GET /api/runs/:runId/events`.

## Consequences

- False-positive boundary violations on sibling files and exports are eliminated.
- LLM hallucinated commit rewrites during retries are replaced by deterministic runner git operations.
- Interrupted or resumed runs recover cleanly without false phase attribution or erasing manual operator repairs.
- Task manifest contracts remain strict on deliverables while allowing realistic engineering changes within bounded directory subtrees.

## Addendum (2026-08-27): Terminal-Fix Narrow Scope Extension Policy (`unowned_narrow_v1`)

### Context and Intent

This addendum refines rather than supersedes ADR-0010. Strict task boundary classification (`classifyTaskChanges`) remains the default and mandatory enforcement mechanism across all normal lifecycle operations, including initial task implementation and standard review-fix loop iterations.

During automated workflows, terminal-fix escalation (invoked only after all standard review-fix loop iterations have been exhausted before failing or transitioning a step) occasionally produces small, incidental adjustments to unowned files (e.g. minor typing fixes or sibling test adjustments) to pass deterministic verification. Rather than halting the run on false-positive drift when a fix is verifiably safe, narrow, and unowned, the terminal-fix path is permitted to evaluate a temporary, ephemeral scope overlay under policy `unowned_narrow_v1`. Ordinary loops and non-terminal execution paths do not use this reconciliation and remain strictly bound to their declared scopes.

### Policy Invariants and Decision Rules

1. **Terminal-Only Path**:
   - Scope overlay reconciliation is evaluated exclusively at the terminal-fix escalation boundary in `ImplementStepLoop`.
   - Ordinary task implementation steps and normal review-fix iterations do not evaluate drift reconciliation; any undeclared modification in those loops continues to follow standard drift classification and scope reverter rules.

2. **Global Manifest Stakes vs. Local Permissions**:
   - Candidate files are checked for ownership across all tasks in the manifest (`manifest.tasks`), not only the current task.
   - A candidate file is staked (and disqualified from auto-extension) if it matches:
     - `expected_files` (exact deliverable obligation in any manifest task),
     - `files` (legacy deliverable obligation in any manifest task),
     - `reference_files` (read-only reference declaration in any manifest task),
     - `non_goals` (exact path or directory segment-prefix match in any manifest task).
   - In contrast, `may_extend` and `permitted_areas` represent discretionary, task-local authorisations rather than global ownership claims. A path falling within another task's `permitted_areas` or `may_extend` is not staked, allowing the terminal fixer to adjust genuinely unowned files without spurious ownership conflicts.

3. **Narrow Change Qualification**:
   - **Text Status**: Candidate files must be text files with an exact git status of `modified`. Newly added files (`added`), deleted files (`deleted`), renames (`renamed`), copies (`copied`), type changes (`type_changed`), untracked files, and binary files (`binary: true`) are disqualified.
   - **Fixed Threshold**: The total lines changed across the terminal-fix commit range (`additions + deletions`) must not exceed the fixed threshold of 10 lines (`MAX_TERMINAL_FIX_CHANGED_LINES = 10`).

4. **Fail-Closed Inspection & Summary Ambiguity**:
   - Exact committed-range diff metrics are gathered via `GitPort.fileChangeSummary` between `headBeforeFix` and `headAfterFix`.
   - If summary inspection fails, the git port does not support summary extraction, or multiple/ambiguous summaries are returned for a candidate path, reconciliation fails closed (`decision: 'reject'`).

5. **Atomic Mixed-Commit Rejection**:
   - Reconciliation operates atomically across the entire set of candidate files in the terminal-fix commit.
   - If any candidate file fails qualification (due to categorical protection, manifest stakes, non-narrow diff metrics, additions/deletions, binary content, or reclassification errors), the entire commit is rejected. Partial or cherry-picked scope expansion is never granted.

6. **Immutable Manifest and Ephemeral Scope Overlay**:
   - The task manifest (`input.manifest`) and persistent step configurations are treated as strictly immutable and are never modified on disk.
   - The runner constructs an in-memory ephemeral `overlayScope` (adding qualified paths to `mayExtendFiles`) and executes a defensive reclassification through `classifyTaskChanges`.
   - No manifest modifications persist across subsequent tasks or run-resume boundaries.

7. **Deterministic Verification Gate**:
   - Scope auto-extension authorises boundary permission only; it does not bypass verification. The resulting worktree must still cleanly pass all deterministic gates (typecheck, test suite, and validation commands).

8. **Structured Audit Event Telemetry**:
   - **On Grant**: Emits `step.terminal_fix.scope_auto_extended` at `warn` level with structured audit metadata including `invocationId`, `stepIndex`, `headBeforeFix`, `headAfterFix`, `range`, `grantedFiles`, `files`, `policy` (`unowned_narrow_v1`), `threshold` / `maxChangedLines` (10), `counts` (`files`, `additions`, `deletions`, `totalChangedLines`), `fileSummaries`, and candidate `evidence`.
   - **On Rejection**: Emits `step.terminal_fix.rejected` with structured rejection reasons (`categorical_boundary`, `manifest_stake`, `missing_summary`, `ambiguous_summary`, `non_narrow_summary`, `reclassification_failed`), stakes, and diff summaries.
