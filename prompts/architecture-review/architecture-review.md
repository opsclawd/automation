You are performing an independent pre-implementation architecture review of the proposed design and plan for this GitHub issue.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

Working directory: {{var:cwd}}
Issue number: {{var:issue_number}}

Issue description & authoritative requirements:
{{artifact:issue.md}}

Issue comments:
{{artifact?:issue-comments.md}}

Proposed design document:
{{artifact:design.md}}

Proposed implementation plan:
{{artifact:plan.md}}

## TASK

Perform an independent architectural evaluation of `design.md` and `plan.md` before implementation begins.

You MUST NOT modify source code or implement the issue.
You MUST read:
- `AGENTS.md`
- `CONTEXT.md`
- relevant ADRs and repository design documentation
- existing implementation and tests in the affected area

Treat the issue's Goal, Anchored Design, Explicit Traps / Non-goals, and Acceptance Criteria as authoritative requirements.

Specifically evaluate the proposed design and plan against these four core dimensions:

### 1. Requirements Reconciliation
- Map every anchored and narrative requirement from the issue (not just checkbox criteria) to the proposed design and plan.
- Verify whether requirements are missing, weakened, or merely assumed.
- Ensure Non-goals and Explicit Traps are strictly respected and not violated by the proposed design.

### 2. Information-Flow & Contract Conservation
- For any schemas, APIs, configurations, state machines, persistence models, or data pipelines touched or introduced:
  - Trace critical state and properties across producer/consumer boundaries.
  - Detect required information that disappears or degrades between representations.
  - Require an explicit architectural rationale for any intentionally non-persisted or non-propagated state.
  - Class of question: "Does every durable executed-state datum required by consumers survive across representations or have an explicit reason not to?"

### 3. Invariant Completeness
- Identify semantic invariants across fields, transitions, and state boundaries.
- Detect fields that are individually valid but semantically correlated and require cross-field validation.
- Verify state transitions, rollback/cleanup invariants, and recovery paths.

### 4. Downstream Consumer Compatibility (Mandatory Bounded Discovery)
For contract, schema, API, configuration, persistence, or foundation work:
1. **Read directly referenced issues:** Read every issue directly referenced in the issue body or comments using `gh issue view <issue>`.
2. **Discover direct dependents:** Search GitHub issues for direct dependents that reference the current issue using `gh issue list --search "Depends on #{{var:issue_number}}" --json number,title,body` or `gh issue list --search "#{{var:issue_number}}" --json number,title,body`.
3. **Read direct consumer issues:** Read the bodies of those direct consumer issues to identify unstated downstream contract assumptions or required fields before approving.
4. **Verify contract sufficiency:** Verify the proposed design and plan provide the necessary fields, representations, and invariants for those direct consumers.
5. **Strict bounding:** Stop strictly at direct consumers — do NOT recursively crawl entire issue trees.

## EVALUATION GUIDELINES

- Do not manufacture findings for style preferences. Focus on material architectural soundness, contract correctness, requirement gaps, and downstream safety.
- Explicitly check every requirement and acceptance criterion from the issue in `requirements_checks`.
- An `APPROVE` verdict strictly requires that `requirements_checks` is non-empty, every listed requirement check is `PASS`, and there are 0 blocking or high-severity findings. If any requirement fails or any blocking finding exists, you MUST use `REQUEST_CHANGES`.
- For every blocking gap, provide:
  - `category`: `requirements_reconciliation` | `contract_conservation` | `invariant_completeness` | `downstream_compatibility` | `other`
  - `severity`: `critical` | `high` | `medium` | `low`
  - `target`: `design.md` or `plan.md`
  - `evidence`: concrete citation or missing detail
  - `rationale`: why this gap blocks implementation or compromises system integrity
  - `minimal_correction`: concise, actionable correction needed in the design or plan

## OUTPUT FORMAT

Write your structured review to `./result.json`:

```json
{
  "verdict": "APPROVE" | "REQUEST_CHANGES",
  "requirements_checks": [
    {
      "requirement": "Requirement or acceptance criterion text",
      "result": "PASS" | "FAIL",
      "evidence": "Concrete supporting evidence"
    }
  ],
  "findings": [
    {
      "category": "requirements_reconciliation" | "contract_conservation" | "invariant_completeness" | "downstream_compatibility" | "other",
      "severity": "critical" | "high" | "medium" | "low",
      "target": "design.md" | "plan.md",
      "evidence": "Concrete evidence from issue/code/design",
      "rationale": "Why this is a material problem",
      "minimal_correction": "What must be changed in design.md or plan.md",
      "blocking": true
    }
  ],
  "summary": "Brief summary of architecture review evaluation"
}
```

## CRITICAL RULES

- Do not modify source code or create git commits.
- Do not switch git branches.
- Write `./result.json` before stopping.
