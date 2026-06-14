#!/usr/bin/env bash
set -euo pipefail

BASE_REF="${BASE_REF:-main}"

# Step 1: Diff this PR against base for legacy-parity.bats
diff_output="$(git diff "origin/${BASE_REF}...HEAD" -- scripts/lib/__tests__/legacy-parity.bats 2>/dev/null)" || {
  echo "::notice::Hotfix parity duplicate check skipped — cannot diff against origin/${BASE_REF}"
  exit 0
}

if [[ -z "$diff_output" ]]; then
  echo "::notice::No legacy-parity.bats changes detected — check passed."
  exit 0
fi

# Extract invariant IDs from added @test lines
this_pr_ids="$(echo "$diff_output" | grep '^+.*@test "parity\[' | grep -oE 'parity\[#[^]]+\]' | sort -u || true)"

if [[ -z "$this_pr_ids" ]]; then
  echo "::notice::No new parity test invariant IDs detected in diff — check passed."
  exit 0
fi

# Step 2: Gate on gh CLI and token availability
if ! command -v gh &>/dev/null; then
  echo "::notice::gh CLI not found — skipping duplicate check against open PRs."
  exit 0
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "::notice::GITHUB_TOKEN not set — skipping duplicate check against open PRs."
  exit 0
fi

# Step 3: Get open PRs targeting the base ref
open_prs="$(gh pr list --limit 1000 --state open --base "${BASE_REF}" --json number,headRefName -q '.[] | "\(.number)\t\(.headRefName)"' 2>/dev/null)" || {
  echo "::notice::Could not list open PRs — skipping duplicate check."
  exit 0
}

if [[ -z "$open_prs" ]]; then
  echo "::notice::No other open PRs — check passed."
  exit 0
fi

# Step 4: For each open PR, diff its branch and check for overlapping invariant IDs
conflicts=""

while IFS= read -r pr_line; do
  [[ -z "$pr_line" ]] && continue
  IFS=$'\t' read -r pr_number pr_branch <<< "$pr_line"

  # Skip current PR if its number is known
  if [[ -n "${CURRENT_PR_NUMBER:-}" && "$pr_number" = "${CURRENT_PR_NUMBER}" ]]; then
    continue
  fi

  # Fetch PR diff via gh CLI (works for forked PRs where branch doesn't exist under origin/)
  pr_diff="$(gh pr diff "${pr_number}" -- scripts/lib/__tests__/legacy-parity.bats 2>/dev/null)" || {
    echo "::notice::Skipping PR #${pr_number} — could not fetch PR diff."
    continue
  }

  # Extract invariant IDs from that branch's additions
  pr_ids="$(echo "$pr_diff" | grep '^+.*@test "parity\[' | grep -oE 'parity\[#[^]]+\]' | sort -u || true)"

  if [[ -z "$pr_ids" ]]; then
    continue
  fi

  # Find overlap with this PR's IDs
  while IFS= read -r this_id; do
    [[ -z "$this_id" ]] && continue
    if echo "$pr_ids" | grep -qFx "$this_id"; then
      conflicts="${conflicts}  - ${this_id} appears in open PR #${pr_number} (branch: ${pr_branch})\n"
    fi
  done <<< "$this_pr_ids"
done <<< "$open_prs"

# Step 5: Report conflicts or pass
if [[ -n "$conflicts" ]]; then
  {
    echo "::error::Cherry-picked parity test(s) detected in hotfix PR."
    echo "These parity test invariant IDs already appear in open PRs' branches:"
    echo -e "$conflicts"
    echo ""
    echo "Remediation: Remove the cherry-picked parity tests from this hotfix PR."
    echo "If the hotfix genuinely needs parity tests (rare), rebase the originating"
    echo "branch on top of the hotfix merge commit immediately after the merge."
  } >&2
  exit 1
fi

echo "::notice::Hotfix parity duplicate check passed — no conflicts with open PRs."
exit 0
