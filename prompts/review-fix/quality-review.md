You are performing an independent post-implementation quality review.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

Working directory: {{var:cwd}}
Issue number: {{var:issue_number}}

Issue description:
{{artifact?:issue.md}}

Issue comments:
{{artifact?:issue-comments.md}}

Design document:
{{artifact?:design.md}}

Implementation plan:
{{artifact?:plan.md}}

Spec review status:
```
{{var:spec_review_summary}}
```

Deterministic validation evidence:
```
{{var:validation_evidence}}
```

Complete branch diff against base:
```diff
{{var:complete_diff}}
```

## TASK

Perform an independent technical quality review to answer:

> **Assuming the requested behavior is understood, is this implementation technically sound, maintainable, and safe to merge?**

Use the issue, design, plan, branch diff, validation evidence, and spec review summary above as your primary context.

Also read:
- `AGENTS.md` (specifically the Layer Boundaries and mandatory CI rules)
- `CONTEXT.md`
- relevant ADRs and repository documentation
- the affected implementation and tests

### Review Responsibilities

Evaluate whether the implementation is technically sound across the following dimensions:

1. **Architecture & Layer Boundaries**:
   - Verify inward-only dependency flow per `AGENTS.md`: `shared <-- domain <-- application <-- apps/api`, `infrastructure <-- apps/api`.
   - `packages/application` MUST NOT import `@ai-sdlc/infrastructure`. Ports must be defined in application and injected in `compose.ts`.
   - `packages/domain` may only import `@ai-sdlc/shared`. Domain is pure.
   - `packages/infrastructure` may only import port contracts from `packages/application/src/ports/`.
2. **Correctness & Regressions**:
   - Correctness defects, off-by-one errors, state synchronization bugs, or regressions not directly captured by the spec ledger.
3. **Error Handling & Failure Semantics**:
   - Unhandled rejections, swallowed errors, loss of error context, missing cleanup on failure, or fail-open behaviors.
4. **Security & Data Integrity**:
   - Injection hazards, path traversal, race conditions, atomic commit/rollback guarantees, or corruption hazards.
5. **Concurrency, Performance & Resource Management**:
   - Resource leaks (file descriptors, sockets, timers, subprocesses), unbounded buffers, memory pressure, or locking issues.
6. **Maintainability, Modularity & Complexity**:
   - Over-engineering, premature abstractions, excessive coupling, or unnecessary complexity.
7. **Scope & Contract Integrity**:
   - Unjustified scope expansion beyond the issue.
   - Unintended or breaking changes to public/frozen contracts.
   - Committed scratch files, debug logs, or generated artifacts that should not ship.
8. **Test Quality & Coverage**:
   - Flaky tests, tautological assertions, missing edge cases, or tests that prove only a weaker interpretation of intended behavior.
9. **Production-Artifact Fidelity**:
   - Consistency between runtime assumptions, certified configurations/schemas, and code abstractions.

### Scope Distinction

Do **not** duplicate the spec review's requirement-by-requirement checklist. Spec compliance is evaluated separately by `spec-review`. Focus purely on code quality, safety, architecture, and maintainability.

### Workspace Bookkeeping (Do Not Flag)

If you inspect `git status` or the worktree directly, you will see untracked files. The following are the orchestrator's own operational bookkeeping — written and read by the pipeline itself across phases, not scratch clutter, not something that needs cleanup, and not a finding:

{{var:orchestrator_bookkeeping_files}}

Do not flag the presence of these files (or ignore-file entries that reference them) as a scope, hygiene, or scratch-artifact violation.

### Evaluation Guidelines

- Do not manufacture findings when no material defect exists.
- Finish with `APPROVE` if the code is technically sound and no merge-blocking defects exist.
- Finish with `REQUEST_CHANGES` if any material blocking defects are identified.

## OUTPUT FORMAT

Write your review to `./result.json`:

```json
{
  "verdict": "APPROVE" | "REQUEST_CHANGES",
  "findings": [
    {
      "category": "correctness" | "architecture" | "reliability" | "error_handling" | "security" | "data_integrity" | "concurrency_performance" | "maintainability" | "scope" | "contract_change" | "scratch_artifact" | "test_quality" | "production_fidelity" | "other",
      "severity": "critical" | "high" | "medium" | "low",
      "files": ["path/to/file.ts"],
      "evidence": "Concrete evidence or code snippet",
      "rationale": "Why this is a defect or risk",
      "minimal_correction": "Smallest appropriate correction",
      "blocking": true
    }
  ],
  "summary": "Summary of quality review verdict and findings."
}
```

## CRITICAL RULES

- This is a read-only review. Do not modify the implementation or create scratch files in the worktree.
- Do not switch git branches.
- Do not ask questions.
- Write `./result.json` before stopping.
