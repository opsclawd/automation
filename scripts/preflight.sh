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
#   4. Hand off to `orchestrator run` with any args this script received.
#
# Usage: scripts/preflight.sh --issue 680 [any other `orchestrator run` flags]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  echo "ERROR: $REPO_ROOT has uncommitted changes. Refusing to switch/pull main." >&2
  git -C "$REPO_ROOT" status --short >&2
  exit 1
fi

current_branch=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)
if [[ "$current_branch" != "main" ]]; then
  echo "On '$current_branch', switching to main..."
  git -C "$REPO_ROOT" checkout -q main
fi

echo "==> Fetching origin/main..."
git -C "$REPO_ROOT" fetch -q origin main

local_sha=$(git -C "$REPO_ROOT" rev-parse main)
remote_sha=$(git -C "$REPO_ROOT" rev-parse origin/main)
if [[ "$local_sha" != "$remote_sha" ]]; then
  if git -C "$REPO_ROOT" merge-base --is-ancestor main origin/main; then
    echo "main is behind origin/main, fast-forwarding..."
    git -C "$REPO_ROOT" merge -q --ff-only origin/main
  else
    echo "ERROR: main has diverged from origin/main. Resolve manually before running." >&2
    exit 1
  fi
else
  echo "main is up to date."
fi

echo "==> Starting orchestrator run..."
exec pnpm --filter @ai-sdlc/api dev run "$@"
