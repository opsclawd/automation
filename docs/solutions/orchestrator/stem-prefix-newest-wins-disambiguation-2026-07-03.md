---
title: Stem-Prefix Remediation — Freshness Filter + Newest-Wins Disambiguation
date: 2026-07-03
category: orchestrator
module: packages/infrastructure
problem_type: bug_fix
component: external-cli-runner
severity: medium
applies_when:
  - Agent writes wrong-named artifact files (e.g. `implementation-log-task-N.md` instead of `implementation-log.md`)
  - Multiple wrong-named candidates accumulate in the worktree root
  - Stem-prefix remediation previously skipped silently on `length !== 1`
tags:
  - artifact-remediation
  - stem-prefix
  - mtime-disambiguation
  - invocation-freshness
  - sequential-agent-invariant
related:
  - issue: "#595"
  - related_commit: c1b4a8ab (delete untracked stem-prefix source after remediation)
---

# Stem-Prefix Remediation — Freshness Filter + Newest-Wins Disambiguation

## Problem

`runExternalCli` has a second-pass stem-prefix remediation block that activates when an expected artifact (e.g. `implementation-log.md`) is absent at its declared path. It scans the worktree root for files whose names start with the artifact's stem, end with the artifact's extension, and have a `-` or `_` separator immediately after the stem. It then acted **only when `stemMatches.length === 1`**:

```ts
if (stemMatches.length !== 1) continue;
const srcName = stemMatches[0]!;
```

This guard was fragile. When multiple wrong-named candidates accumulated — from prior partial runs, manual copies, tracked wrong-named files left in git history, or external writers — the guard short-circuited, the orchestrator reported `MISSING_REQUIRED_ARTIFACT`, and the step fell back to the secondary model (`minimax`). In the originating incident (issue #589) the fallback hit a quota-exhausted model and the whole plan stalled.

A naive "pick newest by mtime" replacement is **also unsafe**: stale leftovers from previous invocations are themselves files in the worktree root and will have recent mtimes relative to *the file system clock*, but they are not what the current agent wrote. Picking the newest stale leftover silently marks a run successful using a stale artifact, clearing `MISSING_REQUIRED_ARTIFACT` against a file the current agent never produced. Reviewer feedback on PR #595 flagged this exact failure mode.

## Fix

Two-step filter on the candidate set:

1. **Freshness filter** — keep only candidates whose `mtimeMs >= start`, where `start = Date.now()` captured at the top of `runExternalCli`. Stale leftovers from prior invocations have `mtimeMs < start` and are dropped. A `statSync` failure is treated as stale (`mtimeMs = 0`), so a stat-able sibling wins.
2. **Newest-wins** — if at least one fresh candidate survives, sort by `mtimeMs` descending and pick the first. (Single-candidate case is the sort's identity.)

```ts
if (stemMatches.length === 0) continue;
const freshCandidates = stemMatches.flatMap((name) => {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(join(input.cwd, name)).mtimeMs;
  } catch {
    // Race with concurrent delete: treat as stale so a fresh sibling wins.
  }
  return mtimeMs >= start ? [{ name, mtimeMs }] : [];
});
if (freshCandidates.length === 0) continue;
freshCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
const srcName = freshCandidates[0]!.name;
```

If no candidate passes the freshness filter (everything is stale), remediation is skipped and `MISSING_REQUIRED_ARTIFACT` stays — exactly the conservative behavior reviewer feedback asked for under "keep ambiguous old matches unresolved."

## Why This Is Safe

1. **Invocation-bounded selection.** `start = Date.now()` is captured once per `runExternalCli` invocation. Any file the current agent wrote will have `mtimeMs >= start` (modulo a small clock-skew tolerance — Node uses the same monotonic-ish wall clock for both `mtimeMs` and `Date.now()`). Files older than `start` were definitely not written by this invocation.

2. **Sequential-agent invariant.** The orchestrator runs one agent per step in a single worktree at a time. No two agents write to the same worktree root concurrently. Within the freshness-filtered set, the most recently modified file is, with overwhelming probability, the artifact the current step's agent just wrote.

3. **Identical behavior in the happy path.** When `stemMatches.length === 1` and that file is fresh, the freshness filter trivially passes it through, the sort trivially picks that single element. The downstream body (`copyFileSync`, `remediatedArtifacts` push, `STEM_PREFIX_REMEDIATED` log line, `git ls-files` + conditional `unlinkSync`) is byte-for-byte unchanged.

4. **Conservative failure mode.** If freshness filtering eliminates all candidates, we deliberately do **not** remediate. The orchestrator reports `MISSING_REQUIRED_ARTIFACT` and falls back — exactly the prior behavior under the `length !== 1` guard, but with the new "multiple leftovers → silently succeed" failure mode removed.

5. **Downstream validation.** The chosen file is then validated as the expected artifact in the next phase. A wrong pick surfaces immediately rather than silently passing through.

6. **Defense against `statSync` failures.** A `try`/`catch` around each `statSync` treats failures as `mtimeMs = 0` (stale). A stat-able sibling wins. If every sibling fails to stat (extremely unlikely), the freshness filter rejects all of them and we fall through to `MISSING_REQUIRED_ARTIFACT` — strictly better than the previous silent skip.

7. **Bounded performance.** The stem filter is tight (separator + extension + `!== basename`). In pathological cases the candidate count is a small single-digit number. The `O(N)` `stat` calls per artifact are negligible. We deliberately did **not** batch the per-artifact `readdirSync` into a single sweep — premature optimization, the worktree root is bounded and the existing `misplaced-artifact-brain-recovery-2026-06-27.md` warning about `O(N×M)` applies to brain-directory scans, not worktree roots.

## What Did Not Change

- `findMisplacedCandidate` (first-pass exact-basename subdirectory scan) keeps its strict single-match guard. Subdirectory traversal with an exact name is much less collision-prone than the worktree-root stem scan, and its failure mode is different (agent wrote to wrong directory with correct name).
- The `c1b4a8ab` post-copy untracked-source cleanup still runs. If the chosen candidate is untracked, the source is `unlink`'d after the copy, preventing future accumulation.
- No new ports, no layer-boundary changes, no new workspace dependencies. Pure infrastructure-layer edit.

## Test Coverage

- **Multiple untracked candidates, fresh mtimes → newest wins.** Two `implementation-log-task-*.md` files with `Date.now()`-based mtimes; expect the newer file is copied, the untracked chosen source is cleaned up, the older untracked source remains.
- **Multiple tracked candidates, fresh mtimes → newest wins.** Same shape but committed to git; expect the newer file is copied, both tracked sources remain in git.
- **Only stale candidates → no remediation.** Two wrong-named files pinned to `2026-07-03T00:00:00Z` (before invocation start); expect `MISSING_REQUIRED_ARTIFACT`, no copy, no unlink. This is the regression test for the reviewer-flagged failure mode.
- **Zero matches → no remediation.** Unchanged behavior.

## Related

- Issue #595 — this fix.
- `docs/solutions/integration-issues/misplaced-artifact-brain-recovery-2026-06-27.md` — broader artifact-recovery patterns and the `O(N×M)` warning for brain-directory scans (not worktree roots).
- Commit `c1b4a8ab` — complementary guard that prevents future accumulation by deleting untracked sources after a successful copy.
</content>
</invoke>