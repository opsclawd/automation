---
module: orchestrator
tags: [arbiter, oscillation, review-fix-loop, autonomous, deviation]
problem_type: stuck_loop
date: 2026-05-31
---
# Autonomous Arbitration for Stuck Review/Fix Loops

## Problem

The review/fix loop in `scripts/ai-run-issue-v2` ran statelessly — each iteration had no memory of prior attempts. When a plan contained a contradictory or unsatisfiable verification command (as happened in #137, where a whole-file grep could never pass because the matching content was explicitly out-of-scope), the loop thrashed through all 5 iterations before hard-failing with "Review loop hit max 5 iterations." The fix-review contradiction reconciliation path handled one narrow case but could not handle oscillating verdicts or contradictory verification commands.

## Solution

Introduce an autonomous arbitration layer with four components: loop history accumulation, oscillation detection, an arbiter agent phase, and plan verification lint. When the review-fix loop detects oscillation or stagnation (3+ iterations with alternating or identical verdicts), it invokes the arbiter agent instead of continuing to thrash. The arbiter can resolve via tiebreak, amended verification commands, deviation (proceed with known defect), or blockage. A plan verification lint runs after plan-write as a heuristic pre-check to catch whole-file grep commands that will provoke oscillation.

## Key Functions

- `_append_loop_history()` — writes structured JSON entries after each review-fix iteration, capturing verdicts, diff summaries, and review excerpts
- `_detect_loop_stall()` — examines last 3 history entries, returns `STALL_OSCILLATION` (alternating PASS/FAIL) or `STALL_NO_PROGRESS` (same verdict 3×)
- `run_arbiter()` — invokes the arbiter agent (architect profile) with full context, validates output via `_validate_arbiter_result()`
- `_validate_arbiter_result()` — enforces guardrails on arbiter JSON output (evidence, amendment, cap, classification)
- `_record_deviation()` — writes human-readable and machine-readable deviation records
- `_lint_plan_verification()` — scans plan.md for whole-file grep commands on partially-modified files

## Guardrails

- G1 (evidence): empty evidence in arbiter result → treated as `BLOCKED_IMPL_DEFECT`
- G2 (narrowing only): `RESOLVED_AMENDED` with empty amendment → rejected (can't delete checks)
- G3 (cap): `ARBITER_INVOKED_FOR_TASK` flag prevents second arbiter per task
- G4 (classification gate): `DEVIATION_PROCEED` with `implementation_defect` → rejected
- Loop exhaustion (≥5 iterations) no longer hard-fails — records deviation and proceeds

## Config

New `arbitrate` phase profile entry in `.ai-orchestrator.json` mapping to the `architect` profile (strongest model) with `claude` as fallback. Loop history file path is `review-loop-history.json` in the worktree directory. Deviation records are written to `deviation-record.json` and `deviation-record.md`.

## Trigger

The arbiter fires when `_detect_loop_stall()` returns a non-`STALL_NONE` value and `ARBITER_INVOKED_FOR_TASK` is unset. The plan lint runs automatically after plan-write completion, before the implement phase begins. Deviation recording triggers on loop exhaustion or certain arbiter outcomes.
