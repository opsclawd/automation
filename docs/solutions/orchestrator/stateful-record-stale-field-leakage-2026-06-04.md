---
title: Stale-field leakage in cross-iteration state records (shell jq merge and TS immutable transitions)
date: 2026-06-04
category: orchestrator
module: scripts/lib + packages/domain
problem_type: pattern
component: state-machine
symptoms:
  - a comment shows outcome="fixed" with a commit_sha from a previous poll that no longer applies
  - reply_verified/commit_verified/build_verified carry true from a prior run, allowing promotion without re-verification
  - attempt counter double-increments because two code paths both bump it
  - markReplied on an already-replied record keeps the old replyId/outcome
  - a transition never fires because the caller set a flag but never set the state
root_cause: persisted_record_not_explicitly_cleared_per_iteration
resolution_type: pattern
severity: high
related_components:
  - scripts/lib/comment-state.sh
  - packages/domain/src/pr-review.ts
  - scripts/ai-pr-review-poll
tags:
  - state-machine
  - jq-merge
  - stale-state
  - immutable-transition
  - attempt-counting
  - pr-review
---

# Stale-Field Leakage in Cross-Iteration State Records

## The class of bug

When a per-entity state record (per-comment, per-task) persists **across loop
iterations**, every optional field has a hidden question: *what happens when the
next iteration does not supply this field?* Nearly every field gets that wrong on
the first implementation, in both shell (`jq` merge) and TypeScript (object spread)
forms. This was the dominant failure mode of the PR-review comment-state machine
(`comment-state.sh`, ~8 of 12 fix commits on PR #189) and recurred in the M6-01
TypeScript domain port (PR #207/#208).

The unifying rule: **a record that survives between iterations must explicitly
null/reset fields the new input does not supply. Never rely on merge semantics to
"keep what was there."**

## Manifestation A — `jq` merge preserves stale fields (shell, #129/#189)

`update_comment_outcomes()` initially merged the agent's new outcomes manifest onto
the existing state with `$state * $outcomes` (jq recursive merge). When the new
manifest omitted a field, the old value survived:

| Leaked field | Symptom |
|---|---|
| `commit_sha` from a previous fix | comment shows "fixed" with a stale SHA |
| `no_fix_reason` from a previous no-fix | comment shows "no_fix_needed" with a stale reason |
| `reply_verified` / `commit_verified` / `build_verified` = true | stale verification allows promotion without re-checking |
| old `outcome` when the agent run failed and produced no manifest | agent failure counted as "handled" |

**Fix:** each merge explicitly nulls fields the new manifest doesn't supply
(`.value.commit_sha = (new.commit_sha // null)`), rather than recursive merge. Seven
distinct leakage vectors had to be closed one at a time (PR #189 commits `1f88fb1`,
`f05ea01`, `242c64f`).

## Manifestation B — object spread carries stale optional fields (TS, #200)

`markReplied(c)` and `resetForRetry(c)` used `{ ...c, ... }`, which carried over
`outcome`, `replyId`, `commitSha`, `blockedReason` from the prior state. A
`markReplied` on an already-replied comment silently kept the old `replyId`.

**Fix:** a `stripOptionalFields(c)` helper (`pr-review.ts:113`) that explicitly
copies only the non-optional fields; transitions spread from `stripOptionalFields(c)`
instead of `c`. `resetForRetry` additionally resets all three verification flags to
`false` (retry means verification must happen again).

## The other two recurring bugs in this state machine

### State must be set explicitly, not implied by a flag

Setting `reply_verified=true` without calling `set_comment_state "$cid" "replied"`
means the promotion guard (`can_transition_to_processed`, which only considers
`replied` comments) never fires — the comment is stuck in `pending` forever (PR #189
Finding 1, recurred in a later round). A flag is not a transition. Set the state.

### Attempt counter double-increment via a shared helper with side effects

Two sites incremented `attempts`: `update_comment_outcomes()` (per pending comment
in the merge) and `set_comment_state()` (on transition back to `pending`). When the
demotion path called `set_comment_state "$cid" "pending"`, each failed verification
round counted as 2 attempts, tripping the block threshold too early. **Fix:** the
demotion path bypasses `set_comment_state` and uses direct `jq` to avoid the
duplicate increment.

**Lesson:** a shared helper with an *implicit* side effect (incrementing a counter
on certain transitions) is dangerous when the caller also manages that state. Make
side effects explicit, or have the side-effecting path bypass the helper.

## Per-entity baseline must be captured at first-seen, not per-iteration (#129)

`pre_sha` (the branch SHA when a comment was first observed) was initially captured
once per `process_reviews()` call via `git rev-parse HEAD`. This broke the
re-verification path (no scope) and was semantically wrong: a commit pushed in poll
1 to address a comment would fail the `pre_sha` check in poll 2 because HEAD had
advanced. **Fix:** store `pre_sha` per-comment at `init_comment_state()` time. Each
comment compares its commit against the branch state *when it was first seen*,
regardless of how many polls have elapsed.

## Legacy migration assumptions are a second leak vector (#129)

Seeding the JSON state from pre-existing flat text files bakes in assumptions:
processed IDs → `outcome:"fixed", commit_verified:true` but `commit_sha:null` (can't
recover the SHA from a text file); replied IDs → `outcome:"no_fix_needed"` with a
canned reason. Migrated `no_fix_needed` comments then promote to processed **without
any build verification** (no_fix_needed doesn't require `build_verified`), so the
recheck-bypass bug applies directly to migrated state. Conservative migration
defaults are right, but document which fields are guesses.

## What to know before modifying cross-iteration state

1. For every optional field on a persisted record, decide explicitly: when the next
   iteration omits it, is it cleared or preserved? Encode that decision; don't
   inherit it from merge/spread defaults.
2. Setting a verification flag is never the same as setting state. Promotion guards
   key on **state**.
3. If a shared transition helper has side effects (counters, flag clears), any
   caller that also manages those must bypass the helper.
4. Capture per-entity baselines (SHAs, timestamps) at first-init, store them on the
   record, and reuse the stored value across iterations.
5. Atomic writes: `file > file.tmp && mv file.tmp file` for every `jq` mutation —
   `mv` is atomic on the same filesystem, preventing partial writes if `jq` fails
   mid-output.

## Related

- `docs/solutions/orchestrator/machine-readable-task-manifest-2026-06-02.md` — same `jq` + tmpfile atomic-write pattern
- `docs/solutions/orchestrator/unified-completion-predicate-2026-06-02.md` — resume-path state divergence (a sibling "state read two ways" bug)
