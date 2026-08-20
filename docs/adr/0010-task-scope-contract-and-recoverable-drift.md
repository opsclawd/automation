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
- **`permitted_areas` (Permission only)**: Directory-scoped permission. Defaults to the **immediate parent directory** of each non-root `expected_file`. Root-level files (e.g. `package.json`, `README.md`) authorize only that exact file and **never** derive repository-root (`.`) permission.
- **Explicit Permission Precedence**:
  1. `protected_files` (`.gitignore`, `task-manifest.json`) $\rightarrow$ protected reverter / invariant check.
  2. `non_goals` $\rightarrow$ immediate hard failure (`canRetry: false`).
  3. `downstream expected_files` $\rightarrow$ `premature_implementation` (revert & name owning task).
  4. `reference_files` $\rightarrow$ read-only; modified = manifest fault.
  5. `expected_files` & `may_extend` $\rightarrow$ permitted (tracked or new).
  6. `permitted_areas` $\rightarrow$ tracked file modifications permitted; untracked file creations = drift.
  7. `undeclared untracked` $\rightarrow$ drift.
- **Verification / Empty Tasks**: Tasks with `expected_files: []` requiring write access must explicitly declare `permitted_areas`; otherwise they remain read-only.
- **Classifier-Driven Auto-commit**: The step auto-commit consumes the classifier's permitted-paths output directly, committing only files verified as permitted.
- **Manifest Producers & Compatibility**: Manifest authoring prompts (`prompts/plan-write/`) and `task-context-generator.ts` produce and carry these fields. Legacy V1/V2 manifests with `files` map transparently to `expected_files`.

### 2. Generalized Scope Reverter, Stateful Cap, and Deep Scratch Purge
- When an undeclared file modification or drift is detected:
  - The runner invokes `RevertScopeFilesPort`: restores baseline-present files from the current attempt's pre-step baseline (`preStepHead`), removes newly created baseline-absent files (`git rm -rf`), amends the commit with `--no-edit`, and returns `amendedHeadSha`.
  - Reclassification re-runs against both the amended commit diff and dirty worktree.
  - A per-step, normalized-path $\rightarrow$ count map (`revertCounts: Record<string, number>`) is stored via SQLite migration `0034-add-step-revert-counts.ts` (`revert_counts TEXT NOT NULL DEFAULT '{}'`) on `Step`. Cap is $N = 2$ reverts per path across resumes before escalating to `needs_human_review`.
- Deep scratch file remediation sweeps uncommitted untracked probes across all package subdirectories while preserving orchestrator-written artifacts (`isOrchestratorArtifactPattern`).

### 3. Premature Implementation Classification
- If a modified file belongs to the `expected_files` of a downstream task in the same manifest ($> \text{currentTask.n}$), the runtime classifies the violation as `premature_implementation`.
- The runner mechanically reverts the file to the baseline via `RevertScopeFilesPort`, reports the owning downstream task, and avoids widening declarations.

### 4. Worktree Lifecycle and Phase-Boundary Hygiene
- **Inbound to `implement`**: Mechanical worktree reset restores tracked dirty files to current `HEAD` and purges untracked probe files.
- **On Run Resume**: `orchestrator runs resume` resets the worktree to `initialPreStepHead`. If `initialPreStepHead` is unresolvable, the engine preserves working tree state and transitions safely to `needs_human_review`.
- **Operator Repair Preservation**: If resumed from `needs_human_review` with `resume_disposition: 'preserve_working_tree'`, working tree diffs are classified using the boundary classifier and preserved across inbound cleanliness checks. Discarded paths are logged to the event stream.

### 5. Plan-Review Invariants for Monorepos
- Structured manifest signals (`task_type`, `paired_with_task`, `public_symbols`, `deferred_exports`, `planned_package_scripts`) provide deterministic validation inputs. Tasks are referenced by 1-based index `tasks[].n`.
- **Barrel Exports**: If a task introduces public symbols under `packages/<pkg>/src/<sub>/`, `packages/<pkg>/src/index.ts` must either be in `expected_files` or in `deferred_exports` with an owning task index.
- **Next.js Intermediate Buildability**: Tasks introducing Next.js build scripts (`planned_package_scripts: { "build": "next build" }`) must co-locate minimal structural entrypoints (`app/layout.tsx` + `app/page.tsx` or `pages/_app.tsx` + `pages/index.tsx`) in `expected_files`.
- **RED Validation Parity**: Red tasks (`task_type: 'red'`) must declare failing commands (`! command`) and cannot share identical validation commands with their paired implementation task.

### 6. Failure Taxonomy & Incident Telemetry
- Terminal domain step statuses in `StepStatus` remain lowercase: `pending`, `running`, `success`, `failed`, `needs_human_review`.
- Repeatable incident telemetry (`step.recovered_scope_violation`, `step.premature_implementation`, `step.task_boundary_blocked`) is published through an event-bus decorator in `apps/api/` and persisted to `EventRepository` in SQLite, exposed via existing `GET /api/runs/:runId/events`.

## Consequences

- False-positive boundary violations on sibling files and exports are eliminated.
- LLM hallucinated commit rewrites during retries are replaced by deterministic runner git operations.
- Interrupted or resumed runs recover cleanly without false phase attribution or erasing manual operator repairs.
- Task manifest contracts remain strict on deliverables while allowing realistic engineering changes within bounded directory subtrees.
