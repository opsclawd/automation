# Shared WATCHED_EXACT, WATCHED_PREFIXES, and match_watched() for parity scripts.
# Source this from check-parity-coverage.sh and parity-sweep.sh.
# Caller must have set -euo pipefail before sourcing.

# Scope: the legacy orchestration surfaces being retired in the TS cutover, plus
# the discrete orchestration entrypoints. TS *use-case* directories (pr-review,
# validation) are intentionally NOT watched yet — they are the port targets under
# active feature development, and gating every change there would just force
# constant no-parity-impact declarations. Add those per-file as they freeze
# pre-cutover (#210).
WATCHED_EXACT=(
  "scripts/legacy/ai-run-issue-v2"
  "scripts/legacy/ai-pr-review-poll"
  "apps/cli/src/run-agent.ts"
  "apps/cli/src/run-pr-poll.ts"
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
