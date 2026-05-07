#!/usr/bin/env bash
set -euo pipefail

PR="${1:-}"
if [[ -z "$PR" ]]; then
  echo "Usage: $0 <pr-number>" >&2
  exit 1
fi

RUNS_ROOT="${RUNS_ROOT:-.ai-runs}"
AI_MODEL="${AI_MODEL:-minimax/m2.7}"
AI_CLI="${AI_CLI:-opencode}"
PROMPTS_DIR="${PROMPTS_DIR:-automation/prompts}"
PROMPT_FILE="$(mktemp)"

RUN_DIR="${RUNS_ROOT}/pr-${PR}"
WORKTREE_DIR=""

cleanup() {
  rm -f "$PROMPT_FILE"
  if [[ -n "$WORKTREE_DIR" && -d "$WORKTREE_DIR" ]]; then
    cd /
    git worktree remove "$WORKTREE_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── fetch PR info ────────────────────────────────────────────────────────────
echo "Fetching PR #${PR}..."
BRANCH=$(gh pr view "$PR" --json headRefName --jq '.headRefName')
WORKTREE_DIR=".ai-worktrees/pr-${PR}"

# ── checkout branch ───────────────────────────────────────────────────────────
git fetch origin "$BRANCH" 2>/dev/null || true
git worktree add "$WORKTREE_DIR" -b "ai/pr-${PR}" "origin/${BRANCH}" 2>/dev/null || {
  cd "$WORKTREE_DIR"
  git pull origin "$BRANCH" 2>/dev/null || true
  cd -
}
cd "$WORKTREE_DIR"

# ── write artifacts ───────────────────────────────────────────────────────────
echo "Fetching PR comments..."
mkdir -p "$RUN_DIR"

# PR review comments (inline)
gh api "pulls/${PR}/comments" --jq '.[] | .body' > "${RUN_DIR}/pr-comments.md" 2>/dev/null || true

# PR review comments JSON
gh api "pulls/${PR}/comments" > "${RUN_DIR}/pr-review-comments.json" 2>/dev/null || true

# Issue comments on the PR
gh api "issues/${PR}/comments" > "${RUN_DIR}/pr-issue-comments.json" 2>/dev/null || true

# ── copy scripts + prompts ────────────────────────────────────────────────────
cp -r scripts "$WORKTREE_DIR/scripts" 2>/dev/null || true
cp -r automation/prompts "$WORKTREE_DIR/automation/" 2>/dev/null || true

# ── render + run prompt ───────────────────────────────────────────────────────
envsubst < "${PROMPTS_DIR}/pr-comments.md" > "$PROMPT_FILE"
echo "=== Phase: pr-comments ==="
./scripts/ai-run-agent.sh "$PROMPT_FILE"

# ── validate ─────────────────────────────────────────────────────────────────
if [[ -f scripts/ai-validate.sh ]]; then
  echo "Running validation..."
  ./scripts/ai-validate.sh >> "${RUN_DIR}/validation.log" 2>&1 || true
fi

# ── commit + push ────────────────────────────────────────────────────────────
git add -A
if git diff --staged --quiet; then
  echo "No changes to commit."
else
  echo "Committing PR comment fixes..."
  git commit -m "fix: PR #${PR} comment resolution (automated)"
  git push
fi

# ── post fix log as PR comment ───────────────────────────────────────────────
if [[ -f "${RUN_DIR}/pr-comment-fix-log.md" ]]; then
  gh pr comment "$PR" --body "$(cat "${RUN_DIR}/pr-comment-fix-log.md")"
fi

echo "=== Done: PR #${PR} comment handling complete ==="
