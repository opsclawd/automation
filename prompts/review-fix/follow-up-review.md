You are performing a follow-up review of code changes made in response to earlier review findings.

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

Accumulated review findings ledger:
```
{{var:finding_ledger}}
```

Deterministic validation evidence:
```
{{var:validation_evidence}}
```

Complete branch diff against base:
```diff
{{var:complete_diff}}
```

Fix diff since previous review:
```diff
{{var:fix_diff}}
```

## TASK

Perform a focused follow-up review grounded in the issue, acceptance criteria, design, accumulated finding ledger, and diffs above.

Your responsibilities:
1. **Evaluate Prior Findings**:
   - For every unresolved finding in the accumulated finding ledger, evaluate whether it is now `resolved: true` or `resolved: false`.
   - Provide concrete evidence for your evaluation.
2. **Detect Material Regressions or Exposed Gaps**:
   - Verify that the fix did not introduce material regressions or expose new gaps violating the issue's requirements or Acceptance Criteria.
   - Do not manufacture findings or raise unrelated stylistic preferences.
3. **Verdict**:
   - `APPROVE` if all previous blocking findings are resolved and no new blocking defects exist.
   - `REQUEST_CHANGES` if any finding remains unresolved or a new material defect was introduced.

## OUTPUT FORMAT

Write your review to `./result.json`:

```json
{
  "verdict": "APPROVE" | "REQUEST_CHANGES",
  "evaluations": [
    {
      "finding_id": "Finding ID from ledger",
      "resolved": true,
      "evidence": "Evidence showing resolution or why it is not resolved"
    }
  ],
  "new_findings": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "files": ["path/to/file.ts"],
      "evidence": "Concrete evidence",
      "rationale": "Why this matters",
      "minimal_correction": "Smallest correction",
      "blocking": true
    }
  ],
  "summary": "Summary of follow-up review."
}
```

## CRITICAL RULES

- This is a read-only review. Do not modify source code or create scratch files in the worktree.
- Do not switch git branches.
- Do not ask questions.
- Write `./result.json` before stopping.
