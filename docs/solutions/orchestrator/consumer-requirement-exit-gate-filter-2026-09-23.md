---
title: Downstream Exit-Gate Consumer Requirement Filtering and Traceability Hard-Gate Remediation
date: 2026-09-23
category: orchestrator
module: packages/application
problem_type: bug_fix
component: requirements-ledger
symptoms:
  - architecture-review populates consumer_requirement items from downstream terminal exit-gate criteria
  - spec-review demands present-tense verification evidence for downstream candidate validation or phase GO sign-offs
  - plan-design requirements traceability matrix parsed into normative hard gate DESIGN-2
  - fix-review cannot_fix escalation blocks entire multi-issue batch at first item
root_cause: lack of exit-gate criterion classification and semantic conflation of traceability documentation with normative implementation requirements
resolution_type: code_fix
severity: high
related_components:
  - packages/application/src/phases/requirements-ledger.ts
  - packages/application/src/phases/handlers/architecture-review.ts
  - packages/application/src/phases/handlers/spec-review.ts
  - prompts/plan-design/plan-unified.md
  - prompts/plan-design/plan-design.md
  - prompts/architecture-review/architecture-review.md
  - prompts/architecture-review/architecture-fix.md
  - prompts/review-fix/spec-review.md
tags:
  - requirements-ledger
  - architecture-review
  - spec-review
  - exit-gate
  - batch-orchestration
  - consumer-requirements
  - issue-1269
---

# Downstream Exit-Gate Consumer Requirement Filtering and Traceability Hard-Gate Remediation

## Problem

During sequential batch execution (`batch-2026-09-19-63-64-65-66-67-68-69` on issue #63 in `opsclawd/solutions-studio`, run `3d8501fa-4703-4eec-92d6-ddfcac0f0215`), the pipeline encountered an unrecoverable false failure cascade in `spec-review` that escalated to `cannot_fix` in `fix-review`, stalling the entire 7-issue batch at its first item.

### The Failure Cascade

1. **Downstream Wholesale AC Ingestion**: `architecture-review` (via `buildArchitectureRequirementsLedger` in `packages/application/src/phases/requirements-ledger.ts`) discovered issue #69 (the Phase 3 exit-gate and candidate-validation issue) as a direct consumer of issue #63. Every acceptance-criterion bullet from issue #69 was copied wholesale into `architecture-requirements.json`, including:
   - `CONSUMER-69-AC-9`: `"Real-provider candidate validation is run against a locked SHA with pinned model identity."`
   - `CONSUMER-69-AC-10`: `"Candidate receives an explicit evidence-backed **GO** before Phase 3 is considered complete."` (marked `hardGate: true` because of keyword `"before"`).
2. **Traceability Matrix Pseudo-Requirements**: In `design.md`, a section titled `"6.1 Complete Requirements Traceability Matrix"` was extracted by `extractSections` as an anchored design requirement (`DESIGN-2`, `hardGate: true`) because header whitelisting matched `"requirement"` and did not consider traceability headers descriptive.
3. **Post-Implementation Spec Review Failure**: In `spec-review`, the reviewer demanded code and test verification evidence for `CONSUMER-69-AC-9`, `CONSUMER-69-AC-10`, and `DESIGN-2`. Since issue #63 is a foundational item, candidate validation against a locked SHA and human operator GO sign-offs are post-merge Phase 3 deliverables that only issue #69's harness can run.
4. **Fix-Review Deadlock**: `fix-review` correctly determined that it could not run real-provider candidate validation or forge a Phase 3 GO from within the repository, returning `cannot_fix`.

## Root Cause

Two interacting architectural defects caused this failure:

1. **Lack of Process/Exit-Gate Classification in Consumer Extraction**:
   - Consumer requirement extraction treated all downstream acceptance criteria as contract requirements for upstream PRs.
   - It did not differentiate behavioral/contract criteria (e.g., interfaces, options, models) from downstream process/validation/exit-gate deliverables requiring external authority (real-provider harness runs, locked SHA validation reports, human sign-offs, phase completion gates).
   - The generic hard gate heuristic assigned `hardGate: true` to consumer criteria matching words like `"before"`, imposing adversarial falsification requirements on external processes.

2. **Semantic Conflation of Traceability Documentation with Normative Implementation Requirements**:
   - Traceability sections in `design.md` explain forward-looking enablement for future issues.
   - `extractSections` treated headers containing `"requirement"` as normative design requirements unless matching specific descriptive keywords. Headers with `"traceability"`, `"matrix"`, or `"mapping"` were not recognized as descriptive, converting documentation into hard gates.

## Solution

### 1. Exit-Gate Classifier (`isDownstreamProcessOrExitGateCriterion`)

Added `isDownstreamProcessOrExitGateCriterion(criterionText: string, consumerTitle?: string): boolean` in `packages/application/src/phases/requirements-ledger.ts`:
- Regex filters process phrases: `real-provider ... validation`, `candidate validation ... report`, `locked sha`, `pinned model identity`, `human operator`, `operator sign-off`, `evidence-backed **GO**`, `explicit GO`, `before phase ... is complete`, `phase exit-gate`, `exit-gate deliverable`, `once all items are merged`.
- When the consumer issue is an exit gate (title matching `exit-gate`, `phase-exit`, or `candidate-validation`), additional process phrases (`validation is run`, `certified`, `approval`) are excluded.
- Behavioral criteria (e.g., `Validation harness CLI accepts candidate SHA flag.`) remain preserved.

### 2. Strict Hard-Gate Invariant on Consumer Requirements (`hardGate: false`)

All consumer requirements (`CONSUMER-...`) are explicitly assigned `hardGate: false`. Consumer requirements exist to verify contract representability, never to impose adversarial falsification gates on upstream issues.

### 3. Suppress Fallback for Exit-Gate Consumers

When an exit-gate consumer has all its criteria filtered out, Step 5c suppresses the fallback `CONSUMER-${refNum}-REQ-1` item, preventing the exit-gate title from re-entering the ledger as an impossible demand.

### 4. Treat Traceability Sections in `design.md` as Descriptive

Updated `isDescriptive` in `extractSections(opts.designMd)` to include `traceability`, `matrix`, and `mapping`. Headers such as `Complete Requirements Traceability Matrix` are treated as documentation and skipped from anchored design requirement extraction.

### 5. Explicit Prompt Template Alignment

Updated prompt templates (`plan-unified.md`, `plan-design.md`, `architecture-review.md`, `architecture-fix.md`, `spec-review.md`) to explicitly distinguish upstream contract enablement from downstream execution deliverables.

## Prevention and Verification

- Unit tests in `requirements-ledger.test.ts` and `architecture-requirements.test.ts` verify criterion filtering, hardGate invariants, fallback suppression, and traceability section skipping.
- Integration tests in `spec-review.test.ts` and `architecture-review.test.ts` verify end-to-end ledger generation and clean phase approval without false failure cascades.
