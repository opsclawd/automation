---
title: Review agent result contract hardening — validate + one-shot rerun
date: 2026-05-19
category: orchestrator
module: scripts
problem_type: agent_contract
component: review-fix-loop
symptoms:
  - Review agent writes .result sentinel early, later changes verdict, exits without rewriting .result
  - Orchestrator trusts stale .result and fails run despite narrative PASS
root_cause: missing_validation
resolution_type: pattern
severity: high
related_components:
  - scripts/ai-run-issue-v2
  - scripts/__tests__/validate_review_artifacts.test.sh
tags:
  - agent-contract
  - validation
  - rerun-pattern
  - contradiction-reconciliation
---

# Review Agent Result Contract Hardening — Validate + One-Shot Rerun

## Problem

Review agents can write their `<task>.result` sentinel file early during analysis, later self-correct their verdict in the conversation narrative, and exit without rewriting `.result` or producing the matching `<task>.md` report. The orchestrator trusts the stale sentinel and fails the run.

Two gaps:

1. **No write ordering constraint** — prompts didn't constrain when `.result` vs `.md` are written
2. **No orchestrator-side validation** — `resolve_result` trusted `.result` without checking whether `.md` exists

## Two-Layer Defense

| Layer                   | What it does                                                       |
| ----------------------- | ------------------------------------------------------------------ |
| Prompt hardening        | CRITICAL ORDERING RULE — write `.md` FIRST, `.result` LAST         |
| Orchestrator validation | `validate_review_artifacts` — refuse stale `.result` without `.md` |

## Validation Function

```bash
validate_review_artifacts() {
  local result_file="$1"
  local md_file="$2"
  if [[ -f "$result_file" && ! -f "$md_file" ]]; then
    return 1  # invalid: result exists but md missing
  fi
  return 0   # valid: both present, both absent, or md-without-result
}
```

Returns 0 if valid (both present, both absent, or md-without-result). Returns 1 if `.result` exists but `.md` is missing.

## One-Shot Rerun Pattern

```bash
if ! validate_review_artifacts "$spec_result" "$spec_md"; then
  rerun_reviewer_once "spec" "$TASK_NUM" "$task_title" "$TASK_TEXT" "$BASE_SHA" "$HEAD_SHA" "$IMPL_REPORT"
  if ! validate_review_artifacts "$spec_result" "$spec_md"; then
    orchestrator_fail "invalid_agent_contract: spec-review-task-${TASK_NUM} wrote .result but not .md after re-run"
  fi
fi
```

### `rerun_reviewer_once` function

Top-level function (not inside the loop body) that:

1. Cleans up orphaned artifacts from both `ISSUES_DIR` and `WORKTREE_DIR`
2. Sets `SPEC_REVIEW_RERUN_WARNING=1` to prepend warning to prompt
3. Re-runs the reviewer with the same parameters

```bash
rerun_reviewer_once() {
  local reviewer_type="$1"
  # ... cleanup orphaned .result and .md from both dirs ...
  if [[ "$reviewer_type" == "spec" ]]; then
    SPEC_REVIEW_RERUN_WARNING=1 run_spec_reviewer ...
  fi
}
```

### Rerun warning in prompt

```bash
if [[ "${SPEC_REVIEW_RERUN_WARNING:-}" == "1" ]]; then
  SPEC_REVIEWER_PROMPT="WARNING: Your previous attempt wrote the .result file but did not write the .md report file. This is a contract violation. You MUST write BOTH files in order: .md first, then .result last.

${SPEC_REVIEWER_PROMPT}"
fi
```

## Prompt Hardening (CRITICAL ORDERING RULE)

```
## MANDATORY OUTPUT FILES — write BOTH, in this exact order

**Step 1**: Write `./spec-review-task-${task_n}.md` — ...
**Step 2**: Write `./spec-review-task-${task_n}.result` — ...

CRITICAL ORDERING RULE:
- You MUST write the .md file FIRST, then the .result file LAST.
- Do NOT write the .result file until you have finalized your verdict.
- The .result file is your final action before stopping.
- If you changed your mind during analysis, rewrite BOTH files with the final verdict.
```

## Contradiction Reconciliation (Related)

When `FIX_STATUS == DONE_NO_FIXES_NEEDED` but review says FAIL, the `handle_contradiction_reconciliation` function re-runs the failing review once before aborting. Reuses `rerun_reviewer_once` for the retry mechanics.

See `docs/solutions/orchestrator/review-fix-contradiction-reconciliation-2026-05-19.md`.

## Files

- `scripts/ai-run-issue-v2` — `validate_review_artifacts`, `rerun_reviewer_once`, prompt hardening
- `scripts/__tests__/validate_review_artifacts.test.sh` — 5 test cases
- `scripts/__tests__/resolve_result.test.sh` — 4 test cases

## Key Gotchas

1. **Quality-review prompt was reverted** — the CRITICAL ORDERING RULE was applied to spec-review but not quality-review during the review fix loop. Both should have it.
2. **`rerun_reviewer_once` must be top-level** — not inside the loop body, to avoid function redefinition on every iteration.
3. **Agents write to WORKTREE_DIR** — not `ISSUES_DIR`. All `resolve_result` calls use worktree paths.
4. **`rerun_reviewer_once` cleans up both `.result` and `.md`** — from both `ISSUES_DIR` and `WORKTREE_DIR` to handle edge cases.
