#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/lib/parity-common.sh"

BASE_REF="${BASE_REF:-main}"

PARITY_TEST_PATTERNS=(
  "scripts/lib/__tests__/legacy-parity.bats"
  "scripts/lib/__tests__/parity-"
)

gh_view_body() {
  local pr_body
  if [[ -n "${PR_BODY:-}" ]]; then
    pr_body="$PR_BODY"
  elif [[ -n "${GITHUB_TOKEN:-}" ]] && command -v gh &>/dev/null; then
    pr_body="$(gh pr view --json body -q '.body' 2>/dev/null)" || true
  else
    pr_body=""
  fi
  printf '%s\n' "$pr_body"
}

match_parity_test() {
  local file="$1"
  for pattern in "${PARITY_TEST_PATTERNS[@]}"; do
    if [[ "$file" = "$pattern"* ]]; then
      return 0
    fi
  done
  return 1
}

changed="$(git diff --name-only "origin/${BASE_REF}...HEAD" 2>/dev/null)" || {
  echo "::notice::Parity coverage check skipped — cannot diff against origin/${BASE_REF}"
  exit 0
}

if [[ -z "$changed" ]]; then
  echo "::notice::No files changed — parity coverage check skipped."
  exit 0
fi

watched_paths=()
parity_changed=()
parity_tag_found=0

while IFS= read -r file; do
  [[ -z "$file" ]] && continue
  if match_watched "$file"; then
    watched_paths+=("$file")
  fi
  if match_parity_test "$file"; then
    parity_changed+=("$file")
  fi
done <<< "$changed"

if [[ ${#watched_paths[@]} -eq 0 ]]; then
  echo "::notice::No watched paths changed — parity coverage gate passed."
  exit 0
fi

if [[ ${#parity_changed[@]} -gt 0 ]]; then
  echo "::notice::Parity test file(s) touched: ${parity_changed[*]} — parity coverage gate passed."
  exit 0
fi

bats_files="$(printf '%s\n' "$changed" | grep '\.bats$')" || true
if [[ -n "$bats_files" ]]; then
  while IFS= read -r bats_file; do
    diff_out="$(git diff "origin/${BASE_REF}...HEAD" -- "$bats_file" 2>/dev/null)" || true
    if echo "$diff_out" | grep -q '^\+.*parity\[\#'; then
      echo "::notice::parity[# tag detected in diff of ${bats_file} — parity coverage gate passed."
      parity_tag_found=1
      break
    fi
  done <<< "$bats_files"
fi

if [[ $parity_tag_found -eq 1 ]]; then
  exit 0
fi

pr_body="$(gh_view_body)"
if echo "$pr_body" | grep -qi 'no-parity-impact'; then
  echo "::notice::no-parity-impact declared — parity coverage gate passed."
  exit 0
fi

{
  echo "::error::Parity test coverage required — this PR changes legacy paths but adds no parity test."
  echo "Offending paths: $(IFS=, ; echo "${watched_paths[*]}")"
  echo "See: https://github.com/anomalyco/ai-sdlc-orchestrator/issues/210 (parity matrix)"
  echo "Add a parity test in scripts/lib/__tests__/legacy-parity.bats, or declare no-parity-impact in the PR body."
} >&2
exit 1
