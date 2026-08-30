You are performing an independent pre-implementation architecture review of the proposed design and plan for this GitHub issue.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

Working directory: {{var:cwd}}
Issue number: {{var:issue_number}}

Authoritative requirements ledger:
{{artifact?:architecture-requirements.json}}

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

Treat the issue's Goal, Anchored Design, Explicit Traps / Non-goals, Acceptance Criteria, and the Requirements Ledger as authoritative requirements.

Specifically evaluate the proposed design and plan against these core architectural dimensions:

### 1. Requirements Reconciliation & Deterministic Ledger Disposition
- You MUST disposition EVERY item from `architecture-requirements.json` in `requirements_checks`, referencing its exact `requirement_id`.
- Map every anchored and narrative requirement from the issue (not just checkbox criteria) to the proposed design and plan.
- Verify whether requirements are missing, weakened, or merely assumed.
- Ensure Non-goals and Explicit Traps are strictly respected and not violated by the proposed design.

### 2. Representational Completeness
- For any schemas, APIs, configurations, contracts, or data models:
  - Verify whether every material downstream behavior can be represented without invention, information loss, or ambiguous reconstruction.
  - Do NOT treat "a related field exists" or "the schema is internally consistent" as sufficient proof.
  - Ask explicitly:
    * Can every required trim/loop/range behavior be encoded by the proposed fields?
    * Can requested values be distinguished from actual execution decisions?
    * Can measured/verified output state be distinguished from configured expectations?
    * Can a downstream consumer reconstruct the semantically relevant result without relying on undocumented inference?

### 3. Bounded Consumer Witness & Counterexample Scenarios
- For each material direct-consumer behavior that stresses a proposed contract, construct a concrete witness scenario demonstrating how the design represents it.
- Where edge cases materially change semantics (e.g. source < target duration looping, tail trimming, partial segments), evaluate a bounded counterexample set in `witness_scenarios`.
- If any required scenario cannot be represented unambiguously, you MUST flag it and request changes.

### 4. Provenance-Layer Classification
- When the issue concerns provenance, manifests, execution records, audit state, or similar contracts, classify relevant data into its semantic layer:
  * **requested / declared** (e.g. assemblyProfile, target duration, requested codec)
  * **configured / executed** (e.g. resolved encoder parameters, actual filter graph, executed process args)
  * **measured / verified** (e.g. probe stream metadata, measured duration, verified sample rate, actual bit rate)
- You MUST flag cases where one layer is incorrectly used as evidence for another (e.g., treating a profile/version identifier as proof of executed configuration or measured stream metadata).

### 5. Conditional-Invariant Analysis
- Identify feature-presence implications and conditional requirements across related fields.
- Inspect optional fields whose validity or necessity depends on related state (e.g. `subtitleCues.length > 0 => subtitleStyleProfile must be present`, `soundbed present => executed transformation provenance must be present`).
- Flag conditionally required fields that remain optional without an enforcing invariant.

### 6. Information-Flow & Contract Conservation
- Trace critical state and properties across producer/consumer boundaries.
- Detect required information that disappears or degrades between representations.
- Require an explicit architectural rationale for any intentionally non-persisted or non-propagated state.

### 7. Downstream Consumer Compatibility (Mandatory Bounded Discovery)
For contract, schema, API, configuration, persistence, or foundation work:
1. **Read directly referenced issues:** Read every issue directly referenced in the issue body or comments using `gh issue view <issue>`.
2. **Discover direct dependents:** Search GitHub issues for direct dependents that reference the current issue using `gh issue list --search "Depends on #{{var:issue_number}}" --json number,title,body` or `gh issue list --search "#{{var:issue_number}}" --json number,title,body`.
3. **Read direct consumer issues:** Read the bodies of those direct consumer issues to identify unstated downstream contract assumptions or required fields before approving.
4. **Verify contract sufficiency:** Verify the proposed design and plan provide the necessary fields, representations, and invariants for those direct consumers.
5. **Strict bounding:** Stop strictly at direct consumers — do NOT recursively crawl entire issue trees.

## EVALUATION GUIDELINES

- Do not manufacture findings for style preferences. Focus on material architectural soundness, contract correctness, requirement gaps, and downstream safety.
- Explicitly check every requirement and acceptance criterion from the issue and requirements ledger in `requirements_checks`.
- For PASS/APPROVE on contract-sensitive requirements, evidence MUST identify not only field/file presence but why the representation is sufficient for the required consumer behavior. A statement like "field exists on schema" is INSUFFICIENT for a conditional or semantic requirement.
- An `APPROVE` verdict strictly requires that:
  1. `requirements_checks` is non-empty and EVERY item from `architecture-requirements.json` is dispositioned as `PASS`.
  2. All `witness_scenarios` evaluate to `PASS`.
  3. There are 0 blocking or high-severity findings (`critical`, `high`, `P0`, `P1`, or `blocking: true`).
  If ANY requirement fails, any ledger item is omitted, any witness scenario fails, or any blocking finding exists, you MUST use `REQUEST_CHANGES`.

- For every blocking gap, provide:
  - `category`: `requirements_reconciliation` | `contract_conservation` | `invariant_completeness` | `downstream_compatibility` | `representational_completeness` | `provenance_layering` | `conditional_invariants` | `witness_scenarios` | `other`
  - `severity`: `critical` | `high` | `medium` | `low`
  - `target`: `design.md` or `plan.md`
  - `evidence`: concrete citation or missing detail
  - `rationale`: why this gap blocks implementation or compromises system integrity
  - `minimal_correction`: concise, actionable correction needed in the design or plan
  - `blocking`: true

## OUTPUT FORMAT

Write your structured review to `./result.json`:

```json
{
  "verdict": "APPROVE" | "REQUEST_CHANGES",
  "requirements_checks": [
    {
      "requirement_id": "REQ-1 or AC-1 from ledger",
      "requirement": "Requirement or acceptance criterion text",
      "result": "PASS" | "FAIL",
      "evidence": "Concrete supporting evidence explaining why the representation is sufficient"
    }
  ],
  "witness_scenarios": [
    {
      "scenario": "Description of consumer scenario (e.g. 12s source soundbed looped to 30s timeline)",
      "result": "PASS" | "FAIL",
      "evidence": "How the proposed contract represents this scenario losslessly",
      "counterexample": "Edge case or failure mode if applicable"
    }
  ],
  "findings": [
    {
      "category": "representational_completeness" | "provenance_layering" | "conditional_invariants" | "witness_scenarios" | "requirements_reconciliation" | "contract_conservation" | "invariant_completeness" | "downstream_compatibility" | "other",
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

