# Historical Run Phase Compatibility Mapping

This document provides the definitive compatibility specification for historical orchestrator runs under `legacy` policy (and earlier milestones) stored in SQLite and `.ai-runs/`.

As part of Issue #1176 ([1096.2]), this mapping ensures historical runs remain fully inspectable across the UI (`apps/web`), REST API (`apps/api`), and CLI without depending on runtime loop execution implementations (`plan-review-loop.ts`, `implement-step-loop.ts`, `review-fix-loop.ts`).

---

## 1. Non-Execution Guarantee for Historical Runs

Historical runs executed under the `legacy` execution policy are terminal records. When queried via:
- Web dashboard (`apps/web`)
- REST API (`GET /api/runs/:runId`, `GET /api/runs/:runId/artifacts`)
- Filesystem artifact stores (`.ai-runs/<displayId>/`)

the orchestrator acts purely as a read-only reader and serializer. It parses run metadata (`run.json`), event streams (`events.jsonl`), artifact files (`combined.log`, `stdout.log`, `result.json`), and database rows (`runs.completed_phases`, `runs.current_phase`). It **never** attempts to re-execute or route into legacy loop code.

---

## 2. Supported Historical and Canonical Phases

The following table lists all canonical, lean, legacy, and milestone phases recognized by the system, their schema mapping in `@ai-sdlc/application`, and their display support in `@ai-sdlc/web`:

| Phase Name | Era / Origin | Type | Schema / Result Artifact | UI Display Label (`apps/web`) |
|---|---|---|---|---|
| `plan-design` | Legacy & Lean | Result-producing | `PlanDesignResultSchema` (`result.json`) | "Plan Design" |
| `plan-write` | Legacy loop | Container / Log | `null` (no `result.json`) | "Plan Write" |
| `plan-review` | Legacy loop | Container / Log | `null` (no `result.json`) | "Plan Review" |
| `plan-fix` | Lean & Legacy | Result-producing | `PlanFixResultSchema` (`result.json`) | "Plan Fix" |
| `implement` | All eras | Result-producing | `ImplementResultSchema` (`result.json`) | "Implementation" |
| `spec-review` | Legacy loop internal | Result-producing | `SpecReviewResultSchema` (`result.json`) | "Spec Review" |
| `quality-review` | Legacy loop internal | Result-producing | `QualityReviewResultSchema` (`result.json`) | "Quality Review" |
| `fix-review` | Legacy loop internal | Result-producing | `FixReviewResultSchema` (`result.json`) | "Fix Review" |
| `whole-pr-review` | Legacy loop internal | Result-producing | `WholePrReviewResultSchema` (`result.json`) | "Whole PR Review" |
| `review-fix` | Target / Canonical | Container / Loop | `null` (no top-level `result.json`) | "Review & Fix" |
| `whole-change-review` | Lean | Result-producing | `WholeChangeReviewResultSchema` (`result.json`) | "Whole Change Review" |
| `narrow-verification` | Lean | Result-producing | `NarrowVerificationResultSchema` (`result.json`) | "Narrow Verification" |
| `compound` | All eras | Result-producing | `CompoundResultSchema` (`result.json`) | "Compound" |
| `create-pr` | All eras | Result-producing | `CreatePrResultSchema` (`result.json`) | "Create PR" |
| `post-pr-review` | Canonical | Container / Poll | `null` (polling container) | "Post PR Review" |
| `pr-review-poll` | Legacy alias | Alias to `post-pr-review` | `null` (maps to `post-pr-review`) | "PR Review Polling" |
| `validate` | Legacy & Lean | Validation step | `null` (exit code & logs) | "Validation" |
| `verify` | Milestone 1 legacy | Validation step | `null` (exit code & logs) | "Validation (Legacy)" |
| `review` | Milestone 1 legacy | Review container | `null` (exit code & logs) | "Review (Legacy)" |
| `architecture-review` | Architecture phase | Result-producing | `ArchitectureReviewResultSchema` (`result.json`) | "Architecture Review" |
| `arbiter` | Arbiter phase | Result-producing | `ArbiterResultSchema` (`result.json`) | "Arbiter Review" |
| `plan-review-arbiter` | Arbiter phase | Result-producing | `PlanReviewArbiterResultSchema` (`result.json`) | "Plan Review Arbiter" |
| `implement-final-review-arbiter` | Arbiter phase | Result-producing | `ImplementFinalReviewArbiterResultSchema` (`result.json`) | "Implement Review Arbiter" |

---

## 3. Phase ID Normalization

Historical runs frequently emitted phase identifiers augmented with subtask indices, loop iteration markers, or numeric step suffixes (for example, `implement-task-1`, `fix-review-loop-2`, `quality-review-task-2`, or `implement-1`).

The function `normalizePhaseId(raw: string): string` in `packages/application/src/results/phase-registry.ts` strips these suffixes in order:
1. Strips `-task-\S+` (e.g. `implement-task-1` → `implement`)
2. Strips `-loop-\S+` (e.g. `fix-review-loop-2` → `fix-review`)
3. Strips `-\d+$` (e.g. `plan-design-1` → `plan-design`)

This guarantees that subtask and loop event entries resolve correctly against schema validators and display metadata.

---

## 4. Phase Name Migration Mapping (`PHASE_NAME_MIGRATION_MAP`)

`PHASE_NAME_MIGRATION_MAP` in `packages/application/src/results/phase-registry.ts` establishes explicit mappings:
1. **Aliases**:
   - `'pr-review-poll': 'post-pr-review'`
2. **Explicit Non-Result Phases (`null`)**:
   - Historical phases that orchestrate loops or run bash scripts without generating a structured `result.json` artifact are mapped explicitly to `null`:
     - `'plan-write': null`
     - `'plan-review': null`
     - `'review-fix': null`
     - `'post-pr-review': null`
     - `'validate': null`
     - `'verify': null`
     - `'review': null`
   - When `PHASE_NAME_MIGRATION_MAP[phase] === null`, `getPhaseResultMeta(phase)` immediately returns `undefined` without falling through to `PHASE_RESULT_REGISTRY`.
3. **Structured Result-Producing Phases**:
   - All phases registered in `PHASE_RESULT_REGISTRY` (such as `spec-review`, `quality-review`, `fix-review`, `whole-pr-review`, `whole-change-review`, `narrow-verification`, `compound`, `fix-validate`, `arbiter`) are explicitly mapped to themselves in `PHASE_NAME_MIGRATION_MAP`.

---

## 5. UI Timeline Rendering (`apps/web`)

In `apps/web/src/lib/timeline.ts`:
- **Default / Empty Event Stream**: When a run has no events yet, `derivePhaseTimeline` renders the canonical 9 baseline phases (`CANONICAL_PHASE_ORDER`) as `pending`.
- **Historical Event Stream**: When an event stream contains historical phases (e.g. `plan-write`, `plan-review`, `post-pr-review`, `validate`), `derivePhaseTimeline` dynamically incorporates known historical phases (`KNOWN_HISTORICAL_PHASES`) at their appropriate chronological timeline positions.
- **Labels (`PhaseTimeline.tsx`)**: Human-readable display labels in `PHASE_LABELS` ensure legacy phases display clean titles in the web timeline rather than raw identifier strings.

---

## 6. Intentionally Out-of-Scope Phase Identifiers & Rationale

1. **Arbitrary Subprocess / Script Names**:
   Raw bash script names or arbitrary one-off command strings (such as `scripts/run-tests.sh` or `git-commit`) are intentionally excluded from `PHASE_NAME_MIGRATION_MAP` and `PHASE_RESULT_REGISTRY`.
   *Rationale*: These represent command-level subprocess executions inside an enclosing step, not orchestration phases. They do not have structured schema contracts.

2. **Loop Implementations in Read Path**:
   Legacy loop implementations (`plan-review-loop.ts`, `implement-step-loop.ts`, `review-fix-loop.ts`) are **not** imported or invoked anywhere in the read, inspect, or timeline paths.
   *Rationale*: Issue #1096.3 and #1096.4 will delete these loop implementations. Verifying that the read and inspection surfaces are completely decoupled from the loop execution code guarantees that deleting those files will not break historical run inspection.
