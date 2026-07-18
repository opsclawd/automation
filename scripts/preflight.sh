#!/usr/bin/env bash
# scripts/preflight.sh
#
# Run before starting an orchestrator run:
#   1. Kill orphaned vitest/node worker processes that survive their dead
#      parent and slowly exhaust RAM+swap until the kernel OOM-kills the
#      orchestrator itself (see .ai-runs postmortem for issue #679).
#   2. Sweep leaked test-fixture temp dirs from /tmp and verify free space.
#      Test suites leak mkdtemp fixture dirs (layered-config-*, ai-orch-*,
#      ...) at a rate of thousands per day of heavy testing; on a tmpfs /tmp
#      this ends in ENOSPC mid-run — observed 2026-07-12 failing a terminal
#      fixer's deterministic verification with a green tree (run 0207d0d0,
#      issue #760).
#   3. Ensure REPO_ROOT is on main and up to date with origin/main.
#   4. Run the same freshness check against every repository the run may
#      execute on: an explicit --target-repo-root argument, or otherwise all
#      enabled registered repositories in the control-plane DB. Target repos
#      are checked with untracked files ignored — orchestrator state dirs
#      (.ai-runs, .ai-worktrees, .ai-tmp) live there untracked by design.
#   5. Hand off to `orchestrator run` with any args this script received.
#
# Usage: scripts/preflight.sh --issue 680 [any other `orchestrator run` flags]

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Ensure the checkout at $1 is clean, on branch $2, and fast-forwarded to
# origin/$2. $3 selects dirtiness scope: "strict" fails on untracked files
# too; "ignore" only fails on tracked changes.
preflight_check_repo() {
  local repo_root=$1 branch=$2 untracked=${3:-strict}

  local status_args=(status --porcelain)
  if [[ "$untracked" == "ignore" ]]; then
    status_args+=(--untracked-files=no)
  fi
  if [[ -n "$(git -C "$repo_root" "${status_args[@]}")" ]]; then
    echo "ERROR: $repo_root has uncommitted changes. Refusing to switch/pull $branch." >&2
    git -C "$repo_root" status --short >&2
    return 1
  fi

  local current_branch
  current_branch=$(git -C "$repo_root" rev-parse --abbrev-ref HEAD)
  if [[ "$current_branch" != "$branch" ]]; then
    echo "On '$current_branch', switching to $branch..."
    git -C "$repo_root" checkout -q "$branch"
  fi

  echo "Fetching origin/$branch..."
  git -C "$repo_root" fetch -q origin "$branch"

  local local_sha remote_sha
  local_sha=$(git -C "$repo_root" rev-parse "$branch")
  remote_sha=$(git -C "$repo_root" rev-parse "origin/$branch")
  if [[ "$local_sha" != "$remote_sha" ]]; then
    if git -C "$repo_root" merge-base --is-ancestor "$branch" "origin/$branch"; then
      echo "$branch is behind origin/$branch, fast-forwarding..."
      git -C "$repo_root" merge -q --ff-only "origin/$branch"
    else
      echo "ERROR: $branch has diverged from origin/$branch in $repo_root. Resolve manually before running." >&2
      return 1
    fi
  else
    echo "$branch is up to date."
  fi
}

# Emit one "path|branch" line per repository the run may execute against.
# An explicit --target-repo-root argument wins (legacy single-target mode;
# branch left empty for the caller to resolve). Otherwise every enabled
# registered repository in the control-plane DB at $1.
preflight_target_repos() {
  local db=$1
  shift
  local prev="" arg
  for arg in "$@"; do
    if [[ "$prev" == "--target-repo-root" ]]; then
      echo "$arg|"
      return 0
    fi
    if [[ "$arg" == --target-repo-root=* ]]; then
      echo "${arg#--target-repo-root=}|"
      return 0
    fi
    prev=$arg
  done

  [[ -f "$db" ]] || return 0
  if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "WARN: sqlite3 not found; skipping registered-repo git checks." >&2
    return 0
  fi
  sqlite3 "$db" "SELECT local_base_path || '|' || default_branch FROM repositories WHERE enabled = 1;" 2>/dev/null || true
}

# When sourced (tests), expose the functions above without executing.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

set -euo pipefail

echo "==> Killing orphaned vitest/node worker processes..."
orphans=$(ps -eo pid,ppid,cmd | awk '$2==1 && $0~/vitest|node \(vitest/ {print $1}')
if [[ -n "$orphans" ]]; then
  echo "Found orphaned workers (PPID 1): $orphans"
  # shellcheck disable=SC2086
  kill -9 $orphans 2>/dev/null || true
  echo "Killed."
else
  echo "None found."
fi
command -v free >/dev/null 2>&1 && free -h || true

echo "==> Sweeping leaked test-fixture temp dirs from /tmp..."
# Known mkdtemp prefixes leaked by the workspace's test suites. Only
# top-level /tmp entries older than 60 minutes — anything younger may
# belong to a live test run.
TMP_LEAK_PREFIXES=(
  layered-config ai-orch ai-wlr ai-jqr ai-wrr opencode-test opencode-log
  pi-test bats-run persist-transcript-test impl-fix-prompt lint-task-size
  vitest
)
swept=0
for prefix in "${TMP_LEAK_PREFIXES[@]}"; do
  while IFS= read -r -d '' entry; do
    rm -rf "$entry" 2>/dev/null || true
    swept=$((swept + 1))
  done < <(find /tmp -maxdepth 1 -name "${prefix}*" -mmin +60 -print0 2>/dev/null)
done
# Regenerable caches that grow unbounded on tmpfs.
rm -rf /tmp/node-compile-cache 2>/dev/null || true
find /tmp -maxdepth 1 -name '.fb*.so' -mmin +60 -delete 2>/dev/null || true
echo "Swept $swept leaked entries."

echo "==> Checking /tmp free space..."
TMP_MIN_FREE_MB=2048
tmp_avail_mb=$(df --output=avail -m /tmp 2>/dev/null | tail -1 | tr -d ' ')
if [[ -n "$tmp_avail_mb" && "$tmp_avail_mb" -lt "$TMP_MIN_FREE_MB" ]]; then
  echo "ERROR: /tmp has only ${tmp_avail_mb}MB free (< ${TMP_MIN_FREE_MB}MB)." >&2
  echo "A full /tmp fails vitest/pnpm mid-run with ENOSPC — often disguised" >&2
  echo "as a test failure. Free space (check .pnpm-store, stray worktrees," >&2
  echo "browser temp files) and re-run." >&2
  df -h /tmp >&2
  exit 1
fi
echo "/tmp OK (${tmp_avail_mb}MB free)."

echo "==> Checking REPO_ROOT git state ($REPO_ROOT)..."
preflight_check_repo "$REPO_ROOT" main strict

echo "==> Checking target repository git state..."
targets_checked=0
while IFS='|' read -r target_root target_branch; do
  [[ -z "$target_root" ]] && continue
  [[ "$target_root" == "$REPO_ROOT" ]] && continue
  if [[ ! -d "$target_root" ]]; then
    echo "WARN: target repo $target_root does not exist; skipping git check." >&2
    continue
  fi
  if [[ -z "$target_branch" ]]; then
    target_branch=$(git -C "$target_root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
    target_branch=${target_branch:-main}
  fi
  echo "--> $target_root (branch $target_branch)"
  preflight_check_repo "$target_root" "$target_branch" ignore
  targets_checked=$((targets_checked + 1))
done < <(preflight_target_repos "$REPO_ROOT/.ai-runs/orchestrator.sqlite" "$@")
if [[ "$targets_checked" -eq 0 ]]; then
  echo "No separate target repositories to check."
fi

echo "==> Starting orchestrator run..."
exec pnpm --filter @ai-sdlc/api dev run "$@"
