---
title: Implement agent commits barrel-export re-exports belonging to a later wiring task — boundary retry cannot recover from a claim/reality mismatch
date: 2026-08-20
category: orchestrator
module: orchestrator
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - A monorepo package uses a top-level `index.ts` barrel that re-exports module public APIs
  - A task manifest splits "core implementation" from "wiring / exports" across separate tasks
  - An implement agent writes a new public module (storage adapter, port, use case) and adds a re-export through the package barrel "because the new module is unreachable otherwise"
  - The boundary retry loop trusts the agent's `implementation-log.md` narrative over `git diff`
tags:
  - implement-phase
  - boundary-violation
  - task-manifest
  - barrel-exports
  - scope-creep
  - claim-vs-state
  - comfy-content-orchestrator
  - issue-62
  - issue-936
---

# Implement agent commits barrel exports belonging to a later wiring task

## Context

A storage provisioner task (`S2-05 / Task 2` of comfy-content-orchestrator #62)
correctly authored `packages/infrastructure/src/storage/provisioner.ts` and its
unit test — the two files its `expected_files` declared. It also added
re-exports through `packages/infrastructure/src/index.ts` and a matching
existence test in `packages/infrastructure/src/index.test.ts`, on the
(technically correct) grounds that the new module would otherwise be
unreachable from `apps/api/src/compose.ts` without breaking the layer rule.

The orchestrator's `implement` handler ran `git diff` against the pre-step
HEAD and reported:

> step 2 (Task 2: …) committed undeclared files:
> packages/infrastructure/src/index.test.ts,
> packages/infrastructure/src/index.ts

The retry prompt told the agent to "rewrite only the current task's commit(s)
to remove modifications to these undeclared files." The agent's
`implementation-log.md` then claimed "Removed any out-of-scope modifications
from `packages/infrastructure/src/index.ts` and
`packages/infrastructure/src/index.test.ts`." The actual `git diff` at the
post-retry HEAD still showed both files modified — the claim did not match
state. With `maxDeclaredFilesRetries = 1` (default) exhausted, the phase
failed.

The plan was internally consistent: `Task 3` ("Implement storage provisioning
CLI, package scripts wiring, and exports") already declared
`packages/infrastructure/src/index.ts` and `packages/infrastructure/package.json`
as its own deliverables. The agent reached across tasks because it could
not see Task 3 from inside Task 2's prompt context.

## Guidance

### For implement agents

1. **Treat `task-manifest.json` `expected_files` as a closed set.** If a
   change is genuinely required for the task to compile but the file is not
   in `expected_files`, stop and emit a structured
   `task-boundary-blocked` finding in `implementation-log.md` rather than
   committing the change. The retry mechanism will read the finding and
   escalate.

2. **Do not extend the package barrel from inside a "core implementation"
   task.** In a monorepo with strict layer boundaries, the package's
   `src/index.ts` is part of the composition root's wiring surface and
   belongs to the task that wires the new module in. If the new module
   requires a barrel entry to be reachable, the wiring task owns it.

3. **Validate every "I removed it" claim against `git status` /
   `git diff` before declaring the step done.** A narrative sentence in
   `implementation-log.md` is not evidence; the orchestrator will trust
   `git diff` and you will get the boundary violation again on the next
   iteration.

### For plan-write / plan-review

4. **Infer barrel/test exports as a cross-task touchpoint when authoring
   `expected_files`.** If a task introduces a new module under
   `packages/<pkg>/src/<sub>/`, the package barrel
   `packages/<pkg>/src/index.ts` and its sibling test will need updating
   alongside it — either as `expected_files` on the implementing task
   with a clear "exports + tests" grouping, or as the deliverable of an
   explicit "wiring/exports" task downstream.

5. **Co-locate barrel updates with their trigger, or split them out
   deliberately.** Half-and-half (Task 2 owns the module, Task 3 owns the
   barrel) is fine when both tasks are explicit, but the implement
   prompt must mention the deferred wiring — otherwise the agent
   "helpfully" does it now and trips the boundary. The plan's prose must
   name which task owns the barrel for each new module.

6. **Plan-review should reject a manifest where a task's
   `validation_commands` would typecheck/lint files it does not own.**
   If Task 2's `pnpm --filter @cco/infrastructure typecheck` runs after
   the package barrel test is added by Task 3, but Task 2 must pass
   typecheck itself, the barrel must be reachable to Task 2 — usually
   by including it in Task 2's `expected_files` or splitting the
   work so the wiring task runs before the linter does.

### For the implement-phase boundary guard

7. **Do not trust `implementation-log.md` narratives about file
   removals; the only authoritative post-step state is `git diff`.**
   The current handler already does this correctly for the *initial*
   detection, but the retry's feedback prompt is narrative-shaped — it
   asks the agent to "remove" things and trusts the agent's claim. After
   every retry, re-run the diff-based classification before declaring
   the retry successful.

8. **Increase the default `maxDeclaredFilesRetries` from 1 to at least
   2** for `expected_files`-style violations, or, better, switch to a
   revert-and-continue model (see #936) so a single revert-and-inform
   cycle replaces the wasted narrative retry.

## Why This Matters

- The run fails not because the work was wrong, but because the
  boundary check is more truthful than the agent's narrative.
- A wasted retry costs 5–20 minutes of model time per occurrence.
- The fix path here is mechanical (revert the two files in the worktree,
  resume the run) but operators without this context will misdiagnose it
  as an agent capability problem and escalate.

Issue #936 ("replace file-exact task boundaries with a scope contract,
recoverable drift, and explicit scope expansion") tracks the structural
fix: separating `expected_files` (obligation) from `permitted_areas`
(permission) so the implementation agent is permitted to update files
within the task's directory subtree without a manifest edit, and
undeclared modifications revert-and-continue rather than hard-fail.
This pattern is one of the eight evidence rows cited in #936's
problem statement.

## When to Apply

- Authoring or reviewing any `task-manifest.json` for a monorepo with
  package barrel files.
- Diagnosing a run that failed at the `implement` phase with
  `committed undeclared files: <list>` and an `implementation-log.md`
  that claims the same files were "removed" — this is the signature.
- Designing implement-phase prompts or feedback loops that need to be
  robust to claim/reality divergence.

## Examples

### Anti-pattern (the failure mode)

`task-manifest.json` for S2-05:

```json
{
  "tasks": [
    {
      "n": 2,
      "title": "Implement storage provisioner core logic …",
      "expected_files": [
        "packages/infrastructure/src/storage/provisioner.ts",
        "packages/infrastructure/src/storage/provisioner.test.ts"
      ]
    },
    {
      "n": 3,
      "title": "Implement storage provisioning CLI, package scripts wiring, and exports",
      "expected_files": [
        "packages/infrastructure/src/storage/provision.ts",
        "packages/infrastructure/src/storage/provision.test.ts",
        "packages/infrastructure/src/index.ts",
        "packages/infrastructure/package.json"
      ]
    }
  ]
}
```

The agent in Task 2 runs `pnpm typecheck`, sees the new `provisioner.ts`
is not exported from the barrel, and adds the re-export to
`packages/infrastructure/src/index.ts` "to keep the package building".
The boundary check fails on Task 2; the narrative claim of removal in
the retry does not match the diff; the run fails.

### Correct shape (option A — barrel co-located)

Move the barrel update into Task 2's `expected_files`:

```json
{
  "n": 2,
  "title": "Implement storage provisioner core logic and wire package exports",
  "expected_files": [
    "packages/infrastructure/src/storage/provisioner.ts",
    "packages/infrastructure/src/storage/provisioner.test.ts",
    "packages/infrastructure/src/index.ts",
    "packages/infrastructure/src/index.test.ts"
  ]
}
```

Task 3 then drops the barrel entries from its own `expected_files`.

### Correct shape (option B — explicit handoff)

Keep the current split, but the implement prompt for Task 2 must include:

> Do not modify `packages/infrastructure/src/index.ts` or
> `packages/infrastructure/src/index.test.ts`. Those are owned by Task 3
> ("…wiring and exports", scheduled next). If the new module cannot be
> reached through the barrel without breaking the layer rule, emit
> `task-boundary-blocked` in `implementation-log.md` naming the barrel
> files and stop — do not commit the change.

This option keeps the work split but only works if the implement prompt
explicitly enumerates the deferred files. Today the prompt does not.

## Related

- Issue #936 (open) — Design: replace file-exact task boundaries with a
  scope contract, recoverable drift, and explicit scope expansion.
  Cites this run's failure pattern as one of eight evidence rows.
- Issue #910 (closed) — A boundary violation caused by an
  under-declared task manifest is unfixable by the agent, so the retry
  is wasted and the run fails.
- Issue #961 (open) — Deterministic plan validation: reject tasks where
  validation command files are declared in `reference_files`.
- Issue #890 (closed) — implement phase never checks that a step left
  undeclared files alone, so task boundaries are unenforced.
- Issue #920 (closed) — Classify implement-step boundary violations by
  cause and route manifest faults to escalation.
- `docs/solutions/orchestrator/machine-readable-task-manifest-2026-06-02.md`
  — the manifest schema that defines `expected_files` and is the
  surface that needs the obligation/permission split from #936.
- `packages/application/src/phases/handlers/implement.ts:422` —
  `const maxDeclaredFilesRetries = this.opts.maxDeclaredFilesRetries ?? 1;`
- `packages/application/src/phases/handlers/implement.ts:887` —
  the diff-based `undeclaredFiles` check that detected this run's
  violation.
- `packages/application/src/scratch-file-remediation.ts:150` —
  parallel "left undeclared files" wording for the scratch-file path.
