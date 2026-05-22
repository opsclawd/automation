---
title: Worktree exclude seeding — idempotent helper with resume-path coverage
date: 2026-05-18
category: orchestrator
module: scripts
problem_type: bug
component: seed_excludes
symptoms:
  - Orchestrator artifacts (design.md, plan.md, *.log) committed into PR branches
  - info/exclude only exists for issue-1 worktree; other worktrees lack it
root_cause: conditional_logic_gap
resolution_type: bug-fix
severity: medium
related_components:
  - scripts/ai-run-issue-v2
tags:
  - git-worktree
  - exclude
  - resume-path
---

# Worktree Exclude Seeding — Idempotent Helper with Resume-Path Coverage

## Problem

`scripts/ai-run-issue-v2` seeded `.git/info/exclude` rules only inside the `read_issue` phase block. When a run resumes from any later phase, the `if [[ "$PHASE" == "read_issue" ]]` guard skips the entire exclude-seeding block.

Without exclude rules, `git add -A` picks up orchestrator artifacts and commits them into the PR branch.

## Solution

### `seed_excludes()` helper function

Single function called from `ensure_worktree` (both happy path and recovery path):

```bash
seed_excludes() {
  if [[ -z "${WORKTREE_DIR:-}" ]] || [[ ! -e "${WORKTREE_DIR}/.git" ]]; then
    return 1
  fi
  local common_dir
  common_dir=$(cd "$WORKTREE_DIR" && git rev-parse --git-common-dir)
  mkdir -p "${common_dir}/info"
  cat >> "${common_dir}/info/exclude" << 'EOF'
*.log
*.result
code-review.md
review.md
design.md
plan.md
compound.md
implementation-log.md
node_modules/
.next/
EOF
}
```

### Placement in `ensure_worktree()`

```bash
ensure_worktree() {
  if [[ -e "${WORKTREE_DIR}/.git" ]]; then
    seed_excludes    # ← seed on every invocation
    return 0
  fi
  # ... recovery logic ...
  seed_excludes      # ← seed after recovery
}
```

### Key Properties

1. **Idempotent via append** — `cat >>` naturally appends; duplicate lines in `info/exclude` are harmless for git's exclude matching. No dedup logic needed.

2. **Guard clause** — validates `WORKTREE_DIR` is set and `.git` exists before proceeding. Returns 1 if not ready, preventing failures in edge states.

3. **`git rev-parse --git-common-dir`** — resolves to `.git/` (the common dir) for worktrees, not `.git/worktrees/issue-N/`. `info/exclude` is read from the common dir, so this is correct.

4. **Quoted heredoc** — `<< 'EOF'` (quoted) prevents variable expansion inside the heredoc.

5. **`${VAR:-}` syntax** — prevents `set -u` errors when variables might be unset.

## Why Not Inline in Each Phase?

| Option                                 | Approach                                     | Verdict                                     |
| -------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| Inline in each phase block             | Duplicated across 5+ phase blocks            | Rejected — easy to miss on future refactors |
| `seed_excludes` from `ensure_worktree` | Single call site; co-locates worktree health | **Chosen**                                  |
| Standalone call at top of every phase  | Requires adding to every phase block         | Rejected — more surface area                |

`ensure_worktree` already runs unconditionally in every phase after `read_issue` and is the gate that guarantees worktree health. Seeding excludes is part of keeping the worktree healthy.

## Testing

Five regression tests in `scripts/__tests__/seed-excludes.bats`:

1. Writes exclude file with key orchestrator patterns
2. Calling twice appends but does not break (idempotency)
3. Git status returns empty after creating excluded files
4. `git add -A` and commit do not include excluded artifacts
5. **Core regression test**: creates `design.md` + `plan.md` BEFORE calling `seed_excludes`, adds `feature.ts`, commits, asserts only `feature.ts` is in the commit

## Adding a New Exclude Pattern

Edit the heredoc in `seed_excludes()` at one place only. There is no other file to update.

## Test Extraction Pattern

Tests extract `seed_excludes` from the live script using `awk` brace-counting:

```bash
eval "$(awk '
  /^seed_excludes\(\)/ { found=1 }
  found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) exit }
' "${SCRIPT_DIR}/../ai-run-issue-v2")"
```

This is fragile — if the function signature changes, update the pattern. Acceptable trade-off for a ~30-line function.
