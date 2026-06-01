---
module: orchestrator
tags: [arbiter, oscillation, review-fix-loop, autonomous, deviation]
problem_type: stuck_loop
date: 2026-05-31
---

# Autonomous Arbitration for Stuck Review/Fix Loops

## Problem
The review/fix loop in `scripts/ai-run-issue-v2` ran statelessly. When a task contained a contradictory or unsatisfiable verification command, the loop thrashed through all 5 iterations and hard-failed. The system had no mechanism to detect oscillation, escalate to a more capable model, or proceed with an audit trail.

## Solution
Added a tiered escalation ladder:
1. **Loop history injection** — each iteration accumulates structured history in `review-loop-history.json`, injected into reviewer/fixer prompts
2. **Oscillation detection** — `_detect_loop_stall()` detects alternating verdicts or no-progress patterns
3. **Arbiter invocation** — `run_arbiter()` uses the `architect` profile with full context to diagnose deadlocks
4. **Outcome validation** — `_validate_arbiter_result()` enforces guardrails G1-G4 (evidence required, amendments only narrow scope, cap 1 per task, defect classification gates auto-proceed)
5. **Deviation recording** — `_record_deviation()` writes audit trail
6. **PR enrichment** — arbiter rationale and deviation records appended to PR body
7. **Plan verification lint** — heuristic warning for whole-file greps without line-range scoping

## Key Functions
- `_append_loop_history()` — appends iteration record to history JSON
- `_detect_loop_stall()` — returns `STALL_NONE | STALL_OSCILLATION | STALL_NO_PROGRESS`
- `run_arbiter()` — invokes arbiter agent with full context
- `_validate_arbiter_result()` — validates arbiter output against guardrails
- `_record_deviation()` — writes deviation-record.md and .json
- `_lint_plan_verification()` — heuristic lint for verification commands

## Guardrails
- G1: Evidence before override (empty evidence → BLOCKED_IMPL_DEFECT)
- G2: Amendments may only narrow scope (empty amendment rejected)
- G3: Max 1 arbiter invocation per task
- G4: Only verification_spec_defect may auto-proceed; implementation_defect must stop

## Config
`.ai-orchestrator.json` — `arbitrate` phase profile entry using `architect` profile.

## Trigger
Issue #165, diagnosed from #137 (whole-file grep matching out-of-scope content).
