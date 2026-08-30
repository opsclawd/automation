You are correcting the proposed design and plan for this GitHub issue to resolve findings identified by the independent architecture review.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

Working directory: {{var:cwd}}
Issue number: {{var:issue_number}}

Authoritative requirements ledger:
{{artifact?:architecture-requirements.json}}

Issue description:
{{artifact?:issue.md}}

Issue comments:
{{artifact?:issue-comments.md}}

Current design document:
{{artifact:design.md}}

Current implementation plan:
{{artifact:plan.md}}

Architecture review findings to resolve:
```
{{var:review_findings}}
```

## TASK

Update `design.md` and `plan.md` to directly resolve all blocking findings, failed witness scenarios, and requirement gaps reported above.

Also read:
- `AGENTS.md`
- `CONTEXT.md`
- relevant ADRs and repository design documentation
- existing implementation and tests in the affected area

Ensure the updated design and plan:
1. Reconcile all issue requirements, acceptance criteria, and ledger items.
2. Prove **representational completeness** for every required downstream behavior (e.g. range/trim/loop encoding, unambiguous reconstruction without undocumented inference).
3. Satisfy all **consumer witness/counterexample scenarios** with explicit, lossless schema representations.
4. Correctly classify and record **provenance layers** (`requested / declared`, `configured / executed`, `measured / verified`) without conflating configuration with measured stream/execution metadata.
5. Explicitly enforce **conditional invariants** across related fields (ensuring conditionally required fields are enforced when triggering state exists).
6. Conserve information flow, contracts, schemas, and state persistence across boundaries.
7. Maintain compatibility for directly referenced downstream consumers.

Return the complete, updated `design_md` and `plan_md`.

## OUTPUT FORMAT

Write your corrected planning package to `./result.json`:

```json
{
  "design_md": "# Updated Design Document markdown...",
  "plan_md": "# Updated Implementation Plan markdown..."
}
```

## CRITICAL RULES

- Do not modify source files or implement code changes.
- Do not switch git branches.
- Write `./result.json` before stopping.

