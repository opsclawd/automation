---
title: PR review-fix loop failure modes — cross-reviewer contradiction, appeasement traps, fix cascades
date: 2026-06-04
category: orchestrator
module: scripts/ai-pr-review-poll
problem_type: pattern
component: review-fix-loop
symptoms:
  - agent oscillates a single line back and forth across push cycles satisfying opposite reviewers
  - agent implements a reviewer suggestion that re-introduces the bug the PR was built to fix
  - 5+ fix commits where each fix exposes the next edge case
  - CONTRADICTION_FIRED stays false despite a commit directly reverting a prior commit
  - BLOCKED_EXIT treated as terminal when the loop can still recover
root_cause: agent_treats_review_feedback_as_mandate_not_evaluation
resolution_type: pattern
severity: high
related_components:
  - scripts/ai-pr-review-poll
  - scripts/lib/comment-state.sh
tags:
  - review-fix-loop
  - cross-reviewer-contradiction
  - reviewer-appeasement
  - solution-doc-authority
  - incremental-review
  - blocked-exit
  - poll-loop
---

# PR Review-Fix Loop Failure Modes

These are recurring, structural failure modes observed across many PR review-fix
poll loops (PRs #140, #149, #152, #155, #161, #176, #179, #181, #183, #189, #190,
#198, #199, #208). They are independent of any single feature. The unifying root
cause: **the agent treats a reviewer finding as a mandate to implement, rather than
a hypothesis to evaluate against the PR's own design constraints.**

The fix is almost never code — it is a decision discipline the agent must apply
while processing review comments.

## 1. Cross-reviewer contradiction (most expensive)

Two automated reviewers with different expertise domains flag the **same line** in
**opposite directions**. The canonical case (PR #155, issue #151):

| Reviewer | Advice | Concern |
|---|---|---|
| Codex (P1) | use `--print <prompt>` (argv) | documented CLI contract conformance |
| Kilo (CRITICAL) | use `--print -` (stdin) | E2BIG/ARG_MAX vulnerability (the bug the PR fixes) |

The agent flipped twice (`5c254ed` → `8eb1c39` → `1c98c51`), burning 2 of 3 push
cycles. The same pattern recurred on PR #161 (`classifyCommandKind` eslint check:
one reviewer said add `|| c.includes('eslint')`, another said remove it as redundant).

**Why it happens:** Each reviewer is correct within its own frame. The agent has no
mechanism to detect that a current finding reverses a prior cycle's change, so it
applies each suggestion mechanically.

**Resolution discipline:**
- Before applying a finding, check whether a previous cycle changed the **same
  location in the opposite direction**. If so, you have a contradiction, not a bug.
- Resolve it against the **issue's acceptance criteria**, not reviewer authority.
  In #155 the ACs required fixing ARG_MAX → `--print -` wins; CLI-contract
  conformance is secondary for a headless adapter.
- Neither reviewer nor agent proposed the option that satisfied both (`--print-file
  <tmpfile>`). When two valid concerns conflict, actively search for the third option
  that dissolves the tension rather than ping-ponging between the two.

**Detector gap:** `CONTRADICTION_FIRED` did not fire for any of these. The
orchestrator's contradiction detector keys on a *single* reviewer reversing itself
(or review-verdict-vs-fix-status mismatch), not cross-reviewer or cross-commit
contradictions. A commit that directly reverts a prior commit (PR #198: `7d05227`
add-fallback → `17f4ecf` remove-fallback) does not trip it either.

## 2. Solution-doc-as-authority trap

When the compound/solution doc is written **during the same PR** (compound phase
before the review loop), a reviewer can cite it as a binding design spec. The agent
then treats its own hours-old write-down as authoritative and reverts a sound
implementation decision to "match the doc" (PR #155, `forceKillAfterDelay` flip-flopped
5000ms → 500ms → 5000ms citing the doc).

**Why it's a trap:** the solution doc is a *description of what was built*, not a
pre-agreed spec. Citing it as binding creates a circular dependency the agent
cannot rationally resolve — the doc and the implementation came from the same agent.

**Resolution discipline:** treat solution docs created during the current PR as
**draft**, not authoritative. Design decisions remain open to review feedback even
if a freshly-written doc records them. (Contrast: the *issue's* design.md, written
before implementation, IS authoritative — see #4 below.)

## 3. Reviewer-appeasement trap (re-introducing the fixed bug)

The agent implements a reviewer's worst-case "what if X doesn't work" suggestion
without checking whether the suggested fix violates the PR's core design constraint
— and re-introduces the exact bug the PR eliminates. Canonical case (PR #198, issue
#191):

1. Codex P1: "`OPENCODE_SESSION_LOG_DIR` is undocumented — what if production opencode
   ignores it?"
2. Agent adds a fallback scan of the shared log dir (`7d05227`).
3. Next review immediately catches that the fallback re-introduces the cross-worker
   false-positive bug the PR was built to remove.
4. Agent reverts (`17f4ecf`).

The design.md explicitly said "remove the fallback to `~/.local/share/opencode/log`"
— the agent had the answer before implementing the suggestion.

**Resolution discipline:**
- The agent's job during review-fix is to **evaluate** each suggestion against the
  design's constraints, not to implement every suggestion.
- A human-backed (e.g. human-triggered Codex) finding does not mean the suggestion
  is compatible with the design. Weight the *finding* (is there a real gap?)
  separately from the *suggested fix* (does this fix violate a constraint?).
- When a suggestion conflicts with an approved design decision, **reply to the
  thread to discuss the trade-off** before (or instead of) pushing a commit. PR #198
  had `replied=0` — the agent never engaged in discussion, only pushed and reverted.

## 4. Design doc is the authoritative anchor for declining suggestions

The correct counter-pattern to #3. When a suggestion contradicts an approved design
decision, decline it with `no_fix_needed` citing specific design.md lines (PR #198
comment `3358412584` cited design.md:98-99,107-109; PR #192 cited M5-05 non-goals to
defer the re-validate block). This is the right move — but apply it on the **first**
occurrence of the suggestion, not retroactively after implementing-then-reverting.

The pre-implementation issue spec / design.md is binding. Aspirational docs
(`milestone-stories.md`) are **not** — reviewer bots frequently reference the wrong
spec tier and suggest scope creep (PR #207: Codex suggested adding `jobs`/`job_attempts`
tables citing milestone-stories.md; correctly rejected because issue.md scoped the
work narrower).

## 5. Incremental review misses the gestalt → fix cascade

Automated reviewers fire on each commit and (often) only see the diff from the
previous commit. This produces a **fix cascade**: each fix is individually correct
but exposes the next-weakest link, requiring N passes to reach a state a single
holistic review would reach in one (PR #181: 5 successive P1 fixes for the mutation
guard; PR #189: 12 fix commits for comment-state staleness; PR #199: each cleanup
fix introduced a new TOCTOU race).

**Characteristic severity taper** signals genuine convergence:
P1 structural → P1 process gap → P2 simplification → SUGGESTION/test-coverage.

**Implications:**
- Expect cascades when replacing a fragile subsystem with a structured one — the
  edges of the new contract get revealed progressively.
- After a fix, proactively look for the *symmetric* gap the fix implies (PR #183:
  fixing the validate-phase mutation guard exposed the missing guard on the
  revalidation path; the no-op heuristic needed a `phaseId` guard once it existed).
- "Each fix introduces a new edge case" is the expected signature of concurrent
  cleanup logic in bash (PR #199 staging sweep). Budget for it; don't treat the
  third race as a regression.

## 6. BLOCKED_EXIT is not terminal

`BLOCKED_EXIT=true` defers to the human; it does **not** stop the poll daemon. A
human interaction (even a confirming comment) can trigger an automated re-review
that the next poll picks up and resolves autonomously (PR #181: blocked on a
structural mutation-guard defect, then a 5-commit autonomous cascade resolved it
~20 min later, driven entirely by Codex re-reviews — the agent never saw the
human's fix options directly).

`BLOCKED_EXIT` also conflates two distinct causes the compound snapshot cannot
distinguish:
- **BLOCKED_by_infra** — agent harness crash, dependency failure, timeout (PR #183:
  `process-review` agent crashed with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`, exit 2;
  see also the related fix to skip the extractor on non-zero agent exit,
  `docs/solutions/orchestrator/agent-timeout-vs-blocked-distinction-2026-06-03.md`).
- **BLOCKED_by_content** — valid review findings the loop can't auto-resolve.

A future orchestrator that treats BLOCKED as terminal (stop, alert) would lose the
autonomous-recovery path; one that never stops risks runaway loops if a bot keeps
finding issues. Neither extreme is correct.

## 7. `NO_FIXES_NEEDED` skips build verification

When the agent returns `NO_FIXES_NEEDED`, the poll bot skips commit/build
verification entirely as an optimization (PR #192). This is safe **only** because
the agent is contractually forbidden from modifying files on a `no_fix_needed`
outcome — there is no guard enforcing it. If you add a code path where a
`no_fix_needed` resolution can touch files, you must also add build verification to
that path or the optimization silently ships breakage.

## 8. Two-reviewer channel asymmetry

The poll bot processes **inline review threads** (Codex/`gh` review API), not
general PR-level comments. When kilo-code-bot posts a PR-level comment and Codex
posts the same concern as an inline thread, the agent only acts on the inline thread
(PR #192). The kilo carry-forward warning is never acknowledged even though the
identical issue was resolved via the Codex thread. If you wonder why a reviewer's
warning was "ignored," check which channel it arrived on.

## What to do with this

When processing review feedback in the loop:

1. Is this finding the reverse of a prior cycle's change here? → contradiction,
   resolve against acceptance criteria, look for the third option.
2. Does the suggested fix violate an approved design.md decision? → `no_fix_needed`
   citing design lines; reply to discuss before pushing.
3. Is the citing reviewer pointing at an aspirational doc (milestone-stories) vs the
   binding issue spec? → reject scope creep.
4. Is a solution doc being cited as authority but was written during *this* PR? →
   treat as draft, not binding.
5. After fixing, where is the symmetric gap this fix implies?
6. On a `no_fix_needed` outcome, did anything touch files? It must not.

## Related

- `docs/solutions/orchestrator/review-fix-contradiction-reconciliation-2026-05-19.md` — single-reviewer verdict-vs-fix contradiction (what CONTRADICTION_FIRED *does* catch)
- `docs/solutions/orchestrator/autonomous-arbitration-2026-05-31.md` — arbiter for stuck same-reviewer oscillation
- `docs/solutions/orchestrator/agent-timeout-vs-blocked-distinction-2026-06-03.md` — BLOCKED_by_infra vs genuine BLOCKED
