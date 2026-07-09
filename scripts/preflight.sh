#!/usr/bin/env bash
# scripts/preflight.sh
#
# Run before starting an orchestrator run:
#   1. Kill orphaned vitest/node worker processes that survive their dead
#      parent and slowly exhaust RAM+swap until the kernel OOM-kills the
#      orchestrator itself (see .ai-runs postmortem for issue #679).
#   2. Ensure REPO_ROOT is on main and up to date with origin/main.
#   3. Hand off to `orchestrator run` with any args this script received.
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
