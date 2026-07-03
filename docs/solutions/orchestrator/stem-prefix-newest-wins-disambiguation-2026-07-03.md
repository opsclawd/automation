---
title: Stem-Prefix Remediation — Newest-Wins Disambiguation on Multiple Matches
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
  - sequential-agent-invariant
related:
  - issue: "#595"
  - related_commit: c1b4a8ab (delete untracked stem-prefix source after remediation)
---

# Stem-Prefix Remediation — Newest-Wins Disambiguation on Multiple Matches

## Problem

`runExternalCli` has a second-pass stem-prefix remediation block that activates when an expected artifact (e.g. `implementation-log.md`) is absent at its declared path. It scans the worktree root for files whose names start with the artifact's stem, end with the artifact's extension, and have a `-` or `_` separator immediately after the stem. It then acted **only when `stemMatches.length === 1`**:

```ts
if (stemMatches.length !== 1) continue;
const srcName = stemMatches[0]!;
```

This guard was fragile. When multiple wrong-named candidates accumulated — from prior partial runs, manual copies, tracked wrong-named files left in git history, or external writers — the guard short-circuited, the orchestrator reported `MISSING_REQUIRED_ARTIFACT`, and the step fell back to the secondary model (`minimax`). In the originating incident (issue #589) the fallback hit a quota-exhausted model and the whole plan stalled.

## Fix

Replace `length !== 1` with: **if `length === 0`, skip; else sort by `mtimeMs` descending and pick the first**.

```ts
if (stemMatches.length === 0) continue;

const stemMatchesSorted = stemMatches
  .map((name) => {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(join(input.cwd, name)).mtimeMs;
    } catch {
      // Race with concurrent delete: treat as oldest (mtimeMs = 0) so a
      // stat-able sibling wins.
    }
    return { name, mtimeMs };
  })
  .sort((a, b) => b.mtimeMs - a.mtimeMs);

const srcName = stemMatchesSorted[0]!.name;
```

## Why This Is Safe

1. **Sequential-agent invariant.** The orchestrator runs one agent per step in a single worktree at a time. No two agents write to the same worktree root concurrently. The most recently modified file in a stem-filter set is, with overwhelming probability, the artifact the current step's agent just wrote.

2. **Identical behavior in the happy path.** When `length === 1`, the sort trivially picks that single element. The downstream body (`copyFileSync`, `remediatedArtifacts` push, `STEM_PREFIX_REMEDIATED` log line, `git ls-files` + conditional `unlinkSync`) is byte-for-byte unchanged.

3. **Downstream validation.** The chosen file is then validated as the expected artifact in the next phase. A wrong pick surfaces immediately rather than silently passing through.

4. **Defense against `statSync` failures.** A `try`/`catch` around each `statSync` treats failures as `mtimeMs = 0` (oldest). A stat-able sibling wins. If every sibling fails to stat (extremely unlikely), we pick the first in `readdirSync` order — still strictly better than the previous silent skip.

5. **Bounded performance.** The stem filter is tight (separator + extension + `!== basename`). In pathological cases the candidate count is a small single-digit number. The `O(N)` `stat` calls per artifact are negligible. We deliberately did **not** batch the per-artifact `readdirSync` into a single sweep — premature optimization, the worktree root is bounded and the existing `misplaced-artifact-brain-recovery-2026-06-27.md` warning about `O(N×M)` applies to brain-directory scans, not worktree roots.

## What Did Not Change

- `findMisplacedCandidate` (first-pass exact-basename subdirectory scan) keeps its strict single-match guard. Subdirectory traversal with an exact name is much less collision-prone than the worktree-root stem scan, and its failure mode is different (agent wrote to wrong directory with correct name).
- The `c1b4a8ab` post-copy untracked-source cleanup still runs. If the chosen candidate is untracked, the source is `unlink`'d after the copy, preventing future accumulation.
- No new ports, no layer-boundary changes, no new workspace dependencies. Pure infrastructure-layer edit.

## Related

- Issue #595 — this fix.
- `docs/solutions/integration-issues/misplaced-artifact-brain-recovery-2026-06-27.md` — broader artifact-recovery patterns and the `O(N×M)` warning for brain-directory scans (not worktree roots).
- Commit `c1b4a8ab` — complementary guard that prevents future accumulation by deleting untracked sources after a successful copy.