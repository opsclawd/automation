#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/lib/parity-common.sh"

WINDOW="${WINDOW:-7d}"
if [[ "$WINDOW" != "all" ]] && ! [[ "$WINDOW" =~ ^[0-9]+[dwhmy]$ ]]; then
  echo "::error::Invalid WINDOW format: $WINDOW (expected e.g. 7d, 30d, 12h, or 'all')"
  exit 1
fi
# git approxidate does NOT read bare "7d" as 7 days; normalize to a phrase it
# understands ("7 days ago"), or the window silently under-scans.
SINCE_EXPR=""
if [[ "$WINDOW" != "all" ]]; then
  case "${WINDOW##*[0-9]}" in
    d) _unit=days ;; w) _unit=weeks ;; h) _unit=hours ;; m) _unit=minutes ;; y) _unit=years ;;
  esac
  SINCE_EXPR="${WINDOW%[dwhmy]} ${_unit} ago"
fi
ISSUE_NUM=210
REPO="${GITHUB_REPOSITORY:-opsclawd/automation}"
MARKER="<!-- parity-sweep -->"
SWEEP_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

candidates_file="$(mktemp)"
covered_file="$(mktemp)"
candidate_prs="$(mktemp)"
labeled_file="$(mktemp)"
gaps="$(mktemp)"
body_file="$(mktemp)"
trap 'rm -f "$candidates_file" "$covered_file" "$candidate_prs" "$labeled_file" "$gaps" "$body_file"' EXIT

# --- Candidates: PRs merged to main in window that touched watched paths ---
if [[ "$WINDOW" = "all" ]]; then
  git log origin/main --format="%H %s" --no-merges > "$candidates_file"
else
  git log origin/main --since="$SINCE_EXPR" --format="%H %s" --no-merges > "$candidates_file"
fi

# Filter to commits that touched watched paths
while IFS=' ' read -r sha rest; do
  [[ -z "$sha" ]] && continue
  pr_num="$(echo "$rest" | grep -oP '\(#\K[0-9]+(?=\))' | head -n1 || true)"
  [[ -z "$pr_num" ]] && continue
  diff_files="$(git diff --name-only "${sha}^..${sha}" 2>/dev/null)" || true
  while IFS= read -r file; do
    if [[ -n "$file" ]] && match_watched "$file"; then
      echo "${pr_num}|${sha}|${rest}" >> "$candidate_prs"
      break
    fi
  done <<< "$diff_files"
done < "$candidates_file"

sort -t'|' -k1 -n "$candidate_prs" | uniq > "${candidate_prs}.sorted"
mv "${candidate_prs}.sorted" "$candidate_prs"
cp "$candidate_prs" "$candidates_file"

# --- Covered: PRs referenced in parity tests ---
parity_test_files="$(grep -rl 'Source: #\|parity\[\#' scripts/lib/__tests__/legacy-parity.bats scripts/lib/__tests__/parity-*.bats 2>/dev/null || true)"
if [[ -n "$parity_test_files" ]]; then
  # Grab every #NNN on any line that references parity sources, so multi-ref
  # tags like `parity[#279/#280]` or `Source: #279 / #280` are all captured.
  grep -hE 'Source: #|parity\[#' $parity_test_files 2>/dev/null | \
    grep -oP '#\K[0-9]+' | sort -n | uniq > "$covered_file"
fi

# --- Labeled: PRs with no-parity-impact label ---
while IFS='|' read -r pr_num _; do
  [[ -z "$pr_num" ]] && continue
  labels="$(gh api "repos/$REPO/issues/${pr_num}/labels" -q '.[].name' 2>/dev/null)" || true
  if echo "$labels" | grep -Fqx 'no-parity-impact'; then
    echo "$pr_num" >> "$labeled_file"
  fi
done < "$candidates_file"

# --- Gaps = candidates - covered - labeled ---
while IFS='|' read -r pr_num sha rest; do
  [[ -z "$pr_num" ]] && continue
  if grep -qx "$pr_num" "$covered_file" 2>/dev/null; then continue; fi
  if grep -qx "$pr_num" "$labeled_file" 2>/dev/null; then continue; fi
  # Get the first watched path from this PR for display
  pr_path="$(git diff --name-only "${sha}^..${sha}" 2>/dev/null | while read -r f; do
    if match_watched "$f"; then echo "$f"; break; fi
  done)"
  echo "- [ ] #${pr_num} — ${rest} — \`${pr_path:-(no path)}\`" >> "$gaps"
done < "$candidates_file"

# --- Build checklist body ---
{
  echo "$MARKER"
  echo "## Parity Coverage Gaps (auto-generated)"
  echo ""
  echo "Last sweep: $SWEEP_TIME"
  echo ""
  if [[ -s "$gaps" ]]; then
    echo "PRs that touched legacy paths with no parity test yet:"
    echo ""
    cat "$gaps"
    echo ""
    echo "**How to clear an item:** add a parity test referencing this PR via \`Source: #NNN\` or \`parity[#NNN]\`. The next sweep will auto-remove it."
  else
    echo "No gaps detected in the $WINDOW window (or all tracked PRs have parity coverage)."
  fi
} > "$body_file"

# --- Find existing marker comment ---
existing_comment_id="$(
  gh api "repos/$REPO/issues/${ISSUE_NUM}/comments" -q '.[].id' 2>/dev/null | \
    while read -r cid; do
      body="$(gh api "repos/$REPO/issues/comments/${cid}" -q '.body' 2>/dev/null)" || true
      if echo "$body" | grep -qF "$MARKER"; then
        echo "$cid"
        break
      fi
    done
)"

if [[ -n "$existing_comment_id" ]]; then
  gh api "repos/$REPO/issues/comments/${existing_comment_id}" \
    -X PATCH \
    -f body="$(cat "$body_file")" > /dev/null
  echo "::notice::Updated existing parity-sweep comment (ID: ${existing_comment_id}) on #${ISSUE_NUM}"
else
  gh api "repos/$REPO/issues/${ISSUE_NUM}/comments" \
    -f body="$(cat "$body_file")" > /dev/null
  echo "::notice::Created parity-sweep comment on #${ISSUE_NUM}"
fi
