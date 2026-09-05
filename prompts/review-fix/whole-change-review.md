You are performing an independent final review of the completed implementation.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

Working directory: {{var:cwd}}
Issue number: {{var:issue_number}}

Issue description & acceptance criteria:
{{artifact?:issue.md}}

Issue comments:
{{artifact?:issue-comments.md}}

Design document:
{{artifact:design.md}}

Implementation plan:
{{artifact:plan.md}}

Deterministic validation evidence:
```
{{var:validation_evidence}}
```

Complete branch diff against base:
```diff
{{var:complete_diff}}
```

## TASK

Perform an independent final review of the completed implementation to determine whether it is safe to merge.

Use the issue, comments, design, plan, branch diff, and validation evidence provided above as your primary review inputs.

Also read:
- `AGENTS.md`
- `CONTEXT.md`
- relevant ADRs and repository documentation
- the affected implementation and tests

Review the change as a whole. Look for material problems including:
- missing or incorrect issue requirements
- deviations from Anchored Design
- correctness defects or regressions
- architectural violations
- unjustified or unrelated changes
- inadequate tests
- important error-handling, security, data-integrity, concurrency, or performance problems where relevant

### Production-Artifact Fidelity & Environment Grounding

- When issue correctness materially depends on repository-owned runtime configuration, certified templates, profiles, schemas, workflow definitions, migrations, generated contracts, capability declarations, or equivalent runtime artifacts, inspect the authoritative production artifact rather than relying solely on code abstractions or synthetic fixtures.
- Determine which artifact is authoritative from the repository itself rather than assuming test fixtures represent production.
- Synthetic, unit, or integration fixtures support correctness evaluation but cannot by themselves prove correctness when they materially differ from authoritative production artifacts or construct configurations/topologies absent from production.

### Supported Success-Path Verification

- Verify that at least one valid end-to-end success path exists under the actual supported production configuration for the behavior required by the issue.
- A solution is not correct if it merely changes the failure mode or converts one failure into an unavoidable downstream failure, leaving the supported production configuration internally unsatisfiable.
- For optional or capability-dependent behavior, verify consistency among declared capabilities, validation rules, runtime behavior, and output/provenance contracts when materially relevant.
- Report material production-artifact mismatches or unsatisfiable configurations as blocking findings when they violate the issue or Acceptance Criteria.

### Evaluation Guidelines

Do not manufacture findings merely to have findings. Do not block on stylistic preferences unless they create a material correctness or maintainability problem.

Explicitly verify every Acceptance Criterion from the issue as PASS or FAIL with supporting evidence.

For each blocking finding, provide:
- severity
- file/location
- concrete evidence
- why it matters
- the smallest appropriate correction

Finish with:
- `APPROVE` if no merge-blocking defects remain
- `REQUEST_CHANGES` if correction is required

## OUTPUT FORMAT

Write your review to `./result.json`:

```json
{
  "verdict": "APPROVE" | "REQUEST_CHANGES",
  "acceptance_criteria": [
    {
      "criterion": "Acceptance criterion text from issue.md",
      "result": "PASS" | "FAIL",
      "evidence": "Supporting evidence"
    }
  ],
  "findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "files": ["path/to/file.ts"],
      "evidence": "Concrete evidence or code snippet",
      "rationale": "Why this matters",
      "minimal_correction": "Smallest appropriate correction",
      "blocking": true
    }
  ],
  "summary": "Summary of review verdict and findings."
}
```

## CRITICAL RULES

- This is a read-only review. Do not modify the implementation or create scratch files in the worktree.
- Do not switch git branches.
- Do not ask questions.
- Write `./result.json` before stopping.
- If `./result.json` already exists and needs revision (e.g. a second pass over your own review found something new), rewrite the entire file from scratch. Do not patch/diff-edit it — context-based patch tools are unreliable against large JSON arrays, since they require reproducing exact surrounding text; a failed or partial patch application can silently corrupt the file.
