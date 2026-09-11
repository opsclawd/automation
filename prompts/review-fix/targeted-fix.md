You are fixing code review findings identified during the authoritative whole-change review.

## CONTEXT

{{var:WORKSPACE_CONSTRAINTS}}

{{var:SCRATCH_FILE_POLICY}}

Working directory: {{var:cwd}}
Issue number: {{var:issue_number}}

Issue description:
{{artifact?:issue.md}}

Design document:
{{artifact:design.md}}

Implementation plan:
{{artifact:plan.md}}

Review findings to fix:
```
{{var:review_findings}}
```

{{var:validation_critical_files}}

## TASK

Read the review findings and failed acceptance criteria carefully.
Implement the necessary fixes in the repository worktree to resolve all blocking defects.

1. **Targeted Scope**:
   - Fix ONLY what the review findings report. Do not expand scope or refactor unrelated code.
   - Respect repository architectural boundaries (inward dependencies only; do not import `@ai-sdlc/infrastructure` in `packages/application`).
   - Do NOT revert or undo changes in validation-critical files (listed under Validation-Critical Files above) unless you are providing an alternative fix that still passes validation.
   - **Governance and Compliance Gate Integrity**:
     - Do NOT fabricate compliance records, licensing audit notes, or approval metadata to resolve a finding.
     - Do NOT edit production license registries, compliance registries, security exception lists, or legal audit configurations (e.g. `*license-registry*.json`, `*compliance-registry*.json`, or equivalent repository governance files) to flip gate statuses (such as `review_required`, `blocked`, or `pending`) to `approved`.
     - Never weaken fail-closed policy checks or alter authoritative production governance data merely to make a test pass or satisfy an acceptance criterion.
   - **External Authority / Human-Owned Gates**:
     - Distinguish code defects from conditions requiring external authority (legal sign-off, commercial licensing review, physical hardware/certification, human operator credentials or decisions).
     - Automated fixers CANNOT satisfy external authority gates by self-authoring approval or mocking out real-world conditions in production data.
     - If a finding cannot be resolved through code/test fixes within repository boundaries and instead genuinely requires external human or operator action (or would require fabricating compliance data), you MUST NOT falsify data or weaken the gate. Instead, report `"result": "cannot_fix"` with an explanation in `reason`.

2. **Worktree State**:
   - Make the required file modifications and leave the worktree in a finished state for deterministic validation.

## VALIDATION SCOPE

Do not re-run the full repository validation suite yourself. A dedicated
validate/fix-validate phase runs the complete suite immediately after you
finish, with its own properly-sized per-command timeout - separate from
your invocation budget. Re-running it yourself risks exceeding your time
budget before you can write any result at all, which is worse than a
validation failure: it loses the entire turn, including your fix.

{{var:SELF_VERIFY_INSTRUCTIONS}}

Do not run integration suites, Testcontainers-based tests, or
hardware/model-dependent suites (database integration tests, media
encoding/ML inference suites, GPU-dependent render tests, or any
repo-specific equivalent) yourself.

## FINAL ACTION

Write `./fix-review-result.json` with:
```json
{
  "result": "done_with_fixes"
}
```

Or, if any blocking finding cannot be fixed automatically because it requires external authority, legal/licensing audit sign-off, human operator action, or cannot be resolved without fabricating compliance data:
```json
{
  "result": "cannot_fix",
  "reason": "Explain why the finding requires external authority or human intervention and cannot be fixed automatically."
}
```

## CRITICAL RULES

- Do not ask questions.
- Do not switch git branches.
- Do not create commits.
- Never fabricate compliance data or weaken fail-closed governance/licensing gates.
- If a finding requires external authority, legal sign-off, or human operator action, write `result: cannot_fix`.
- Write `./fix-review-result.json` before stopping.
- If `./fix-review-result.json` already exists and needs revision (e.g. a second pass over your own review found something new), rewrite the entire file from scratch. Do not patch/diff-edit it — context-based patch tools are unreliable against large JSON arrays, since they require reproducing exact surrounding text; a failed or partial patch application can silently corrupt the file.
