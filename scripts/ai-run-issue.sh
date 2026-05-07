#!/usr/bin/env bash
set -euo pipefail

# ── inputs ──────────────────────────────────────────────────────────────────
ISSUE="${1:-}"
if [[ -z "$ISSUE" ]]; then
  echo "Usage: $0 <issue-number>" >&2
  exit 1
fi

BASE_BRANCH="${BASE_BRANCH:-main}"
WORKTREE_ROOT="${WORKTREE_ROOT:-.ai-worktrees}"
RUNS_ROOT="${RUNS_ROOT:-.ai-runs}"
AI_MODEL="${AI_MODEL:-minimax/m2.7}"
AI_CLI="${AI_CLI:-opencode}"
PROMPTS_DIR="${PROMPTS_DIR:-automation/prompts}"

RUN_DIR="${RUNS_ROOT}/issue-${ISSUE}"
WORKTREE_DIR="${WORKTREE_ROOT}/issue-${ISSUE}"
BRANCH="ai/issue-${ISSUE}"
PROMPT_FILE="$(mktemp)"

cleanup() { rm -f "$PROMPT_FILE"; }
trap cleanup EXIT

# ── helpers ─────────────────────────────────────────────────────────────────
has_label() {
  local label="$1"
  gh issue view "$ISSUE" --json labels --jq ".labels[].name" | grep -qx "$label"
}

fail() {
  local reason="$1"
  echo "ERROR: $reason" >&2
  gh issue edit "$ISSUE" --remove-label "ai:in-progress" 2>/dev/null || true
  gh issue edit "$ISSUE" --add-label "ai:failed" 2>/dev/null || true
  gh issue comment "$ISSUE" --body "Automation failed: $reason" 2>/dev/null || true
  exit 1
}

run_phase() {
  local phase="$1"
  local prompt_src="${PROMPTS_DIR}/${phase}.md"

  if [[ ! -f "$prompt_src" ]]; then
    fail "Prompt file not found: $prompt_src"
  fi

  # render template vars into PROMPT_FILE
  envsubst < "$prompt_src" > "$PROMPT_FILE"

  echo "=== Phase: $phase ==="
  ./scripts/ai-run-agent.sh "$PROMPT_FILE"
}

# ── pre-flight ──────────────────────────────────────────────────────────────
echo "Checking repo state..."
git fetch origin "$BASE_BRANCH" 2>/dev/null || true
if [[ -n "$(git status --porcelain)" ]]; then
  fail "Repo is dirty. Commit or stash changes first."
fi

# ── fetch issue ──────────────────────────────────────────────────────────────
echo "Fetching issue #${ISSUE}..."
mkdir -p "$RUN_DIR"

gh issue view "$ISSUE" --json number,title,body,url,labels,comments \
  > "${RUN_DIR}/issue.json"

# write human-readable issue body
gh issue view "$ISSUE" --json body --jq '.body' \
  > "${RUN_DIR}/issue.md"

# write comments
gh issue view "$ISSUE" --json comments --jq '.comments[].body' \
  > "${RUN_DIR}/issue-comments.md"

echo "Issue #${ISSUE}: $(gh issue view "$ISSUE" --json title --jq '.title')"

# ── validate labels ─────────────────────────────────────────────────────────
if ! has_label "ai:plan-ready"; then
  fail "Issue does not have ai:plan-ready label."
fi

if has_label "ai:blocked"; then
  fail "Issue has ai:blocked label."
fi

# ── validate required sections ─────────────────────────────────────────────
BODY="${RUN_DIR}/issue.md"
required_sections=("# Goal" "# Approved Design Direction" "# Acceptance Criteria" "# Non-Goals")
for section in "${required_sections[@]}"; do
  if ! grep -q "$section" "$BODY"; then
    fail "Issue body missing required section: $section"
  fi
done

# check open questions
open_questions=$(sed -n '/^# Open Questions$/,/^#/p' "$BODY" | grep -v "^# Open Questions$" | grep -v "^#" | grep -v "^$" | head -5 || true)
if [[ -n "$open_questions" && "$open_questions" != "None." && "$open_questions" != "None" && "$open_questions" != "N/A" && "$open_questions" != "N/A." ]]; then
  fail "Issue has unresolved open questions. Resolve before running."
fi

# ── update labels ────────────────────────────────────────────────────────────
echo "Updating labels..."
gh issue edit "$ISSUE" --remove-label "ai:plan-ready" 2>/dev/null || true
gh issue edit "$ISSUE" --add-label "ai:in-progress" 2>/dev/null || true

# ── create worktree ──────────────────────────────────────────────────────────
echo "Creating worktree at ${WORKTREE_DIR}..."
mkdir -p "$(dirname "$WORKTREE_DIR")"
git worktree add "$WORKTREE_DIR" -b "$BRANCH" "origin/${BASE_BRANCH}"

# ── copy prompts into worktree ───────────────────────────────────────────────
cp -r "$PROMPTS_DIR" "$WORKTREE_DIR/automation/prompts"
cp -r scripts "$WORKTREE_DIR/scripts"

# ── run phases ───────────────────────────────────────────────────────────────
cd "$WORKTREE_DIR"

PHASES=(plan implement validate-initial compound review fix-review validate-final compound-refresh)
for phase in "${PHASES[@]}"; do
  run_phase "$phase" || fail "Phase '$phase' failed."
done

# ── commit after implementation ─────────────────────────────────────────────
echo "Committing implementation..."
git add -A
git commit -m "feat: implement issue #${ISSUE} (automated)" || true

# ── commit after compounding (if docs changed) ──────────────────────────────
git add -A
git commit -m "docs: compound learnings for issue #${ISSUE}" || true

# ── commit after review fixes ────────────────────────────────────────────────
git add -A
git commit -m "fix: review findings for issue #${ISSUE}" || true

# ── commit after compound-refresh ───────────────────────────────────────────
git add -A
git commit -m "docs: refresh compound learnings for issue #${ISSUE}" || true

# ── push branch ─────────────────────────────────────────────────────────────
echo "Pushing branch..."
git push -u origin "$BRANCH"

# ── create PR ────────────────────────────────────────────────────────────────
PR_BODY=$(cat <<EOF
Closes #${ISSUE}

## Summary
Automated implementation of issue #${ISSUE}.

## Verification
See `.ai-runs/issue-${ISSUE}/` for full run artifacts.

## Review findings
See `.ai-runs/issue-${ISSUE}/code-review.md`.
EOF
)

echo "$PR_BODY" > "${RUN_DIR}/pr-body.md"

gh pr create \
  --base "$BASE_BRANCH" \
  --head "$BRANCH" \
  --title "Issue #${ISSUE}: automated implementation" \
  --body-file "${RUN_DIR}/pr-body.md"

# ── update labels ────────────────────────────────────────────────────────────
gh issue edit "$ISSUE" --remove-label "ai:in-progress" 2>/dev/null || true
gh issue edit "$ISSUE" --add-label "ai:pr-opened" 2>/dev/null || true

# ── comment on issue ─────────────────────────────────────────────────────────
PR_URL=$(gh pr view --json url --jq '.url')
gh issue comment "$ISSUE" --body "PR opened: $PR_URL"

echo "=== Done: PR created for issue #${ISSUE} ==="
