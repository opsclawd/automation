# Shared WATCHED_EXACT, WATCHED_PREFIXES, and match_watched() for parity scripts.
# Source this from check-parity-coverage.sh and parity-sweep.sh.
# Caller must have set -euo pipefail before sourcing.

WATCHED_EXACT=(
  "scripts/ai-run-issue-v2"
  "scripts/ai-pr-review-poll"
  "apps/cli/src/run-agent.ts"
)

WATCHED_PREFIXES=(
  "scripts/lib/"
  "packages/infrastructure/src/agent/"
)

match_watched() {
  local file="$1"
  for exact in "${WATCHED_EXACT[@]}"; do
    if [[ "$file" = "$exact" ]]; then
      return 0
    fi
  done
  for prefix in "${WATCHED_PREFIXES[@]}"; do
    if [[ "$file" = "$prefix"* ]]; then
      local rel="${file#"$prefix"}"
      if [[ "$rel" = "__tests__/"* ]]; then
        continue
      fi
      return 0
    fi
  done
  return 1
}
