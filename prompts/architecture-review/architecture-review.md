You are performing an independent pre-implementation architecture review of the proposed design and plan for this GitHub issue.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

Working directory: {{var:cwd}}
Issue number: {{var:issue_number}}

Issue description & authoritative requirements:
{{artifact?:issue.md}}

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

### 4. Downstream Consumer Compatibility (Bounded)
- When the change introduces or modifies contracts, APIs, schemas, persistence formats, or boundaries used by directly referenced dependencies/consumers:
  - Verify the proposed contract is sufficient and backwards/forwards compatible for those direct consumers.
  - Identify breaking mutations that downstream work would immediately require.
  - Do NOT recursively crawl unrelated issue trees; keep analysis strictly bounded to directly referenced dependencies/consumers.

## EVALUATION GUIDELINES

- Do not manufacture findings for style preferences. Focus on material architectural soundness, contract correctness, requirement gaps, and downstream safety.
- Explicitly check every requirement and acceptance criterion from the issue.
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
