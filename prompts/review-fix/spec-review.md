You are performing an independent post-implementation spec review.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

Working directory: {{var:cwd}}
Issue number: {{var:issue_number}}

Issue description & requirements:
{{artifact?:issue.md}}

Issue comments:
{{artifact?:issue-comments.md}}

Design document:
{{artifact:design.md}}

Implementation plan (supporting context only, not authority):
{{artifact?:plan.md}}

Deterministic validation evidence:
```
{{var:validation_evidence}}
```

Complete branch diff against base:
```diff
{{var:complete_diff}}
```

Requirements ledger to disposition:
{{var:requirements_ledger}}

## TASK

Perform an independent post-implementation spec review to answer one question:

> **Does the completed implementation satisfy every normative requirement of the issue and anchored design under the supported production configuration?**

Use the issue, comments, design document, branch diff, validation evidence, and requirements ledger provided above as your primary review inputs.

Also read:
- `AGENTS.md`
- `CONTEXT.md`
- relevant ADRs and repository documentation
- the affected implementation and tests
- authoritative production artifacts when correctness depends on them

### Requirements Ledger Disposition

Before deciding the verdict, evaluate EVERY item from the requirements ledger above. You must explicitly disposition each item by its exact `requirement_id`.

For each requirement check, provide:
- `requirement_id`: Exact ID from the ledger (e.g. `AC-1`, `REQ-DESIGN-1`, `CONSUMER-128-AC-1`)
- `requirement`: The requirement text
- `result`: `PASS` or `FAIL`
- `evidence`: Implementation evidence showing how the requirement is satisfied in code
- `test_evidence`: Test or deterministic validation evidence proving the requirement
- `counterexample_considered`: Required for any item marked `[HARD GATE]`. Provide the adversarial counterexample / stress case considered to falsify compliance.

### Hard Gates & Adversarial Falsification

For hard gates, safety properties, integrity/provenance requirements, ordering requirements, error semantics, and other invariants, attempt to **falsify** compliance using adversarial counterexamples rather than merely finding confirming evidence.

Examples:
1. **Ordering / Fail-Early Invariants**: A requirement like "hash mismatch prevents FFmpeg dispatch" must consider a bad hash on a later input after earlier valid inputs, not only a trivial one-input case.
2. **Provenance & Layering**: Provenance requirements must trace transformations and verify that recorded provenance describes what the authoritative consumer actually consumed, rather than substituting configuration or profile identity for measured behavior.
3. **Capability / Preflight Constraints**: Capability requirements must enumerate every materially required capability rather than checking only one representative dependency.

A single failed normative requirement makes the verdict `FAIL`.

### Production-Artifact Fidelity & Environment Grounding

- When issue correctness materially depends on repository-owned runtime configuration, certified templates, profiles, schemas, workflow definitions, migrations, generated contracts, capability declarations, or equivalent runtime artifacts, inspect the authoritative production artifact rather than relying solely on code abstractions or synthetic fixtures.
- Determine which artifact is authoritative from the repository itself rather than assuming test fixtures represent production.
- Verify that at least one valid end-to-end success path exists under the actual supported production configuration for the behavior required by the issue.

### Workspace Bookkeeping (Do Not Flag)

If you inspect `git status` or the worktree directly, you will see untracked files. The following are the orchestrator's own operational bookkeeping — written and read by the pipeline itself across phases, not scratch clutter, not something that needs cleanup, and not a finding:

{{var:orchestrator_bookkeeping_files}}

Do not flag the presence of these files (or ignore-file entries that reference them) as a scope, hygiene, or scratch-artifact violation.

### Evaluation Guidelines

- Do not manufacture findings when no material defect exists.
- Finish with `PASS` if every requirement is satisfied and no blocking defects remain.
- Finish with `FAIL` if any requirement check fails or blocking findings are identified.

## OUTPUT FORMAT

Write your review to `./result.json`:

```json
{
  "verdict": "PASS" | "FAIL",
  "requirements_checks": [
    {
      "requirement_id": "AC-1",
      "requirement": "Requirement text",
      "result": "PASS" | "FAIL",
      "evidence": "Implementation evidence citing files and logic",
      "test_evidence": "Test coverage proving requirement",
      "counterexample_considered": "Adversarial stress case evaluated (required for hard gates)"
    }
  ],
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "files": ["path/to/file.ts"],
      "evidence": "Concrete evidence or code snippet",
      "rationale": "Why this violates the spec",
      "minimal_correction": "Smallest appropriate correction",
      "blocking": true
    }
  ],
  "summary": "Summary of spec review verdict and findings."
}
```

## CRITICAL RULES

- This is a read-only review. Do not modify the implementation or create scratch files in the worktree.
- Do not switch git branches.
- Do not ask questions.
- Write `./result.json` before stopping.
