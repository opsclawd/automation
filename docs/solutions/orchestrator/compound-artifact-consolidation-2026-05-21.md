---
title: Compound Engineering Artifact Consolidation
date: 2026-05-21
category: orchestrator
module: scripts
problem_type: knowledge_management
component: compound_engineering
symptoms:
  - Per-run compound docs (ai/issues/*/compound.md) are gitignored, never committed
  - Most per-run docs restate PR description — low signal density (~5/20 had durable lessons)
  - PR review poll loop generates no compound artifacts despite highest-signal interactions
  - No mechanism to curate raw artifacts into committed docs/solutions/ topic docs
root_cause: missing_consolidation_pipeline
resolution_type: new_feature
severity: medium
tags:
  - compound-engineering
  - scripts
  - pr-review-poll
  - consolidation
---

# Compound Engineering Artifact Consolidation

## Problem

The orchestrator runs a `compound` phase after every issue run, producing `ai/issues/<N>/compound.md`. These had two problems:

1. **Not committed** — the `ai/` directory is gitignored. The agent is explicitly told not to commit. Output survives only as a local artifact with no durable lifecycle.
2. **Wrong granularity** — most per-run compound docs restate the PR description. A post-M3 audit of 20 docs found ~5 with durable lessons, ~4 medium-value, and ~11 that mostly restate the PR.

Separately, the PR review poll loop (`scripts/ai-pr-review-poll`) handled the back-and-forth that produces the highest-signal lessons (per issues #44/#45) and currently left no trace beyond per-poll logs.

## Solution

Two additive pieces, neither modifying the per-run compound phase in `ai-run-issue-v2`:

### 1. Signal-gated compound emission from the PR review poll

`scripts/lib/poll_compound.sh` — two functions sourced by `ai-pr-review-poll`:

- **`should_emit_compound()`** (`scripts/lib/poll_compound.sh:15`): Returns 0 (emit) when any signal heuristic is true:
  - `DID_PUSH_COMMITS > 0` — commits were pushed during the loop
  - `TOTAL_POLLS > 1` — multiple poll iterations were needed
  - `BLOCKED_EXIT == true` — loop hit blocked exit or exhausted budget
  - `CONTRADICTION_FIRED == true` — contradiction reconciliation fired (reserved for future use)
  - `PROCESSED_IDS_FILE` non-empty — comments reached terminal state
  - Returns 1 otherwise (skip).

- **`emit_compound_doc()`** (`scripts/lib/poll_compound.sh:34`): Writes `ai/poll-pr-${PR_NUMBER}/compound-<ISO-timestamp>.md`. Timestamp suffix (from `date -u +'%Y-%m-%dT%H-%M-%SZ'`) prevents clobbering when the poll loop is rerun against the same PR. Constructs a prompt with PR identity, loop stats, and instructions to write raw material (not curated). Calls `run_agent` (defined in `ai-pr-review-poll`, not in the helper — an intentional design constraint).

Integration in `scripts/ai-pr-review-poll`:

- Sources `poll_compound.sh` at line 61
- Declares `DID_PUSH_COMMITS=0` at line 920 alongside other loop variables
- Increments `DID_PUSH_COMMITS` in both `verify_commits_pushed` success branches (lines 292, 308)
- Calls `should_emit_compound && emit_compound_doc || log "Skipping..."` before the final log line (line 1052)

### 2. Milestone consolidation script

`scripts/ai-consolidate-compound` — standalone script (~159 lines, executable):

**Input discovery** (`scripts/lib/consolidate_helpers.sh:32`):

- Three modes: `auto` (default), `--since <ref>`, `--issues N,M`
- Auto mode: finds all compound files newer than the newest commit touching `docs/solutions/`
- Globs both `ai/issues/*/compound.md` and `ai/poll-pr-*/compound-*.md`
- `--issues` mode excludes poll-pr files entirely (narrows scope to specific issues)

**Agent prompt** (built in `ai-consolidate-compound:68-114`):

- Inlines all existing `docs/solutions/**/*.md` as context
- Inlines all discovered raw inputs as context
- Explicitly permits zero-output ("If nothing warrants a curated doc, write nothing")
- Encodes output conventions: topic-named files, YAML frontmatter, category subdirs

**Confirmation & commit** (`scripts/lib/consolidate_helpers.sh:84`):

- `diff_and_confirm()`: Shows `git diff -- docs/solutions/`, prompts `[y/N]`, returns 0/1. Returns 0 with note when nothing changed (handles zero-output cleanly).
- `commit_consolidation()`: Stages `docs/solutions/`, commits with standard message.
- `--dry-run`: Runs agent, leaves working tree untouched.
- `--yes`: Skips confirmation prompt, commits directly (for CI/non-interactive use).

## Key Decisions and Trade-offs

### Single agent invocation vs. per-file agents

**Chosen:** One agent sees all inputs + existing curated corpus simultaneously. Needed for cross-cutting clustering decisions (merge into existing doc vs. create new). Trade-off: prompt can be large (the pre-M3 batch was ~23 files). Mitigated by 900s timeout, configurable `AGENT_MODEL` env var, and `--since`/`--issues` scoping.

### Bash vs. TypeScript

**Chosen:** Bash, matching existing `scripts/` convention. The script is orchestration (globbing, git ops, agent invocation). Trade-off: no structured parsing; prompt builder uses heredocs.

### Timestamp-suffixed poll files vs. fixed names

**Chosen:** `compound-<ISO>.md`. Poll loop reruns against the same PR must not clobber prior output. Timestamps sort chronologically with no race conditions.

### Git commit recency vs. file mtime for input filtering

**Chosen:** Git ref resolution (`git log -1 --format=%H -- docs/solutions/`), then mtime comparison against committer timestamp. Git ref is a stable, shareable boundary. However, mtime is platform-dependent (`stat -c %Y` vs `stat -f %m`) and can drift with clone/checkout. Acceptable for developer-triggered tooling; CI should use `--issues` for exact control.

### `set -uo pipefail` (tolerant) vs `set -euo pipefail` (strict)

**Chosen:** Tolerant, matching `ai-pr-review-poll`. Helper modules do not set their own errexit.

## Gotchas and Pitfalls

### Env var naming mismatch

The plan used `COMMITS_PUSHED` but the implementation uses `DID_PUSH_COMMITS`. The plan's bats tests used `COMMITS_PUSHED` — the actual test file at `scripts/lib/__tests__/poll_compound.bats:12` sets `export COMMITS_PUSHED=0`, but `poll_compound.sh:16` reads `${DID_PUSH_COMMITS:-0}`. The tests passed because the bats file uses `COMMITS_PUSHED` in the test body only for setting values; the sourced function reads `DID_PUSH_COMMITS`. During review, the variable name was changed but the bats test fixtures were not updated — this was caught and fixed in a review iteration (commit `b4c787b`).

### zsh glob incompatibility

The original `discover_inputs` used `find ai/poll-pr-* -name 'compound-*.md'` which fails in zsh when no matching directories exist (zsh treats unmatched globs as an error by default). Fixed in commit `430952c` by switching to `find ai/ -path '*/poll-pr-*/compound-*.md'` which is shell-agnostic.

### `run_agent` dependency

`emit_compound_doc` calls `run_agent` which is defined in `ai-pr-review-poll`, not in `poll_compound.sh`. Sourcing `poll_compound.sh` outside the poll loop and calling `emit_compound_doc` will fail at runtime. This is intentional — the function is an internal helper, not a public API. Bats tests stub `run_agent` via `export -f`.

### Portability stubs in consolidate_helpers.sh

`consolidate_helpers.sh` defines no-op `log()`/`warn()` stubs at the top (`consolidate_helpers.sh:10-11`) because the sourcing script (`ai-consolidate-compound`) overrides them. Without the stubs, sourcing standalone (e.g., in bats tests) would fail. The sourcing script's versions use `tee -a "$LOG_FILE"` while the stubs use plain echo.

### `diff_and_confirm` in non-interactive contexts

The confirmation prompt reads from stdin via `read -r -p`. In CI or piped contexts, stdin may not be a terminal. The `--yes` flag skips the prompt entirely. The `--dry-run` flag shows the diff without committing. Both flags cover non-interactive use cases.

### mtime vs. git timestamp clock drift

In `--since` and auto modes, `discover_inputs` compares filesystem mtime (`stat -c %Y`) against git committer timestamps. These clocks can diverge — git checkout, clone, `cp -a`, or backup/restore can reset mtime to values that no longer correspond to when the file was written. Documented in the `LIMITATION` comment at `consolidate_helpers.sh:25-29`.

## File Structure

```
scripts/
  ai-consolidate-compound              # NEW — milestone consolidation script (+x)
  lib/
    consolidate_helpers.sh             # NEW — discover_inputs, diff_and_confirm, commit_consolidation
    poll_compound.sh                   # NEW — should_emit_compound, emit_compound_doc
    __tests__/
      consolidate_helpers.bats         # NEW — 6 tests for consolidation helpers
      poll_compound.bats               # NEW — 9 tests for poll helpers
      (poll_compound.bats includes stubbed run_agent via export -f)
  ai-pr-review-poll                    # MODIFIED — sources poll_compound.sh, calls compound at loop exit
```

## Testing

- **Bats tests** for both helper modules, one file per module
- Tests use `TMPDIR_TEST` (mktemp) for isolation
- Poll compound tests stub `run_agent` via `export -f` to avoid shelling out
- Consolidation tests create real git repos to exercise `git diff`/`git commit` detection
- Syntax checked with `bash -n` on all scripts
- End-to-end dry-run smoke tested against the pre-M3 batch (23+ artifacts)

## If You Need to Modify This Code

- **Signal heuristics are in `should_emit_compound()`** — add new conditions as additional `if`/`return` checks. Each heuristic must have a corresponding env var set by the poll loop.
- **Adding new modes to `discover_inputs`**: Add a new `case` branch in the while loop, a new mode variable, and handle it in the dispatch logic below. Keep auto/since/issues mutually exclusive.
- **Changing the agent prompt**: Both `emit_compound_doc` (poll helper) and `ai-consolidate-compound` (main script) construct their own prompts. They are independent — changes to one do not affect the other.
- **Adding new `AGENT_CLI` support**: Add a new case in `ai-consolidate-compound:120-129` `run_agent` function. The syntax is `timeout "$TIMEOUT_SEC" <cli-binary> <args> < "$prompt"`.
- **Bats test style**: One file per sourced module. Tests use `run <function>` for `should_emit_compound`/`discover_inputs`/`diff_and_confirm` (which return codes), but call `emit_compound_doc`/`commit_consolidation` directly (which produce side effects). Ensure `setup()` sources the helper and exports required env vars.
- **Remember** that `poll_compound.sh` needs `run_agent` from its caller — it cannot run standalone. If you need to test or invoke `emit_compound_doc` outside `ai-pr-review-poll`, you must provide a `run_agent` function.
