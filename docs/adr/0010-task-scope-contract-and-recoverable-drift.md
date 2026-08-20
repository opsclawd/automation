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
- **`permitted_areas` (Permission only)**: Directory-scoped permission. Defaults to the **immediate parent directory** of each `expected_file`. Tasks with `expected_files: []` (e.g. verification/cleanup tasks) inherit the cumulative union of `permitted_areas` from all preceding tasks in the manifest.
- **`may_extend`**: Optional list of explicit files outside permitted areas that the task is allowed, but not required, to modify.
- **`non_goals`**: Explicitly forbidden areas/files that fail immediately without a retry cycle.
- **Modify vs. Create Invariant**: Modifying an existing tracked file within a permitted area is allowed; creating a new untracked file requires explicit declaration in `expected_files` or `may_extend`.
- **Auto-commit Sweep**: The step auto-commit sweeps all dirty files within `permitted_areas`, not just `uncommittedDeclared`.

### 2. Mechanical Revert-and-Continue for Recoverable Scope Drift
- When an undeclared file modification is detected:
  - The runner mechanically restores the file using `git checkout <preStepHead> -- <undeclaredFiles>` (or `git restore`) rather than relying on LLM narrative commit rewrites.
  - The step is informed of the revert and continues.
  - A revert cap is enforced: after $N = 2$ reverts of the same path in a step, the runner halts and escalates to `needs_human_review` with a structured `task-boundary-blocked` finding.
- Deep scratch file remediation sweeps uncommitted untracked probes across all package subdirectories, preserving orchestrator-written artifacts.

### 3. Premature Implementation Classification
- If a modified file belongs to the `expected_files` of a *downstream* task in the same manifest, the runtime classifies the violation as `premature_implementation`.
- The runner mechanically reverts the file to the baseline, reports the owning downstream task and schedule, and avoids widening the current task's declaration.

### 4. Worktree Lifecycle and Phase-Boundary Hygiene
- **Inbound to `implement`**: Mechanical worktree reset (`git checkout <baseline> -- .` and untracked probe sweep) runs at the phase transition to ensure probe artifacts from `plan-review` do not fail the inbound cleanliness check.
- **On Run Resume**: `orchestrator runs resume` resets the worktree to `preStepHead` before executing inbound cleanliness checks, preventing false attribution of mid-step working files to prior phases.

### 5. Plan-Review Invariants for Monorepos
- **Barrel Exports**: If a task introduces a new public module under a package, `packages/<pkg>/src/index.ts` must either be co-located in `expected_files` or explicitly deferred with a negative prompt constraint.
- **Intermediate Monorepo Buildability**: Tasks introducing framework CLI commands (e.g. Next.js `"build": "next build"`) must co-locate minimal structural entrypoints (`app/` or `pages/` stubs) in the same task so intermediate step commits leave `pnpm -r build` green.
- **RED/Implementation Validation Parity**: Plan-review rejects RED tasks whose validation command requires failing tests to pass, or RED/implementation task pairs sharing identical validation commands.

### 6. Failure Taxonomy
- Machine-readable outcome categories are recorded on step and run results: `infrastructure_failure`, `implementation_failure`, `recovered_scope_violation`, `fatal_scope_violation`, `premature_implementation`, `review_rejection`, `human_review_required`, `success`.

## Consequences

- False-positive boundary violations on sibling files and exports are eliminated.
- LLM hallucinated commit rewrites during retries are replaced by deterministic runner git operations.
- Interrupted or resumed runs recover cleanly without false phase attribution.
- Task manifest contracts remain strict on deliverables while allowing realistic engineering changes within bounded directory subtrees.
