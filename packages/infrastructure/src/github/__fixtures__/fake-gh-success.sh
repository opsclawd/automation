#!/usr/bin/env bash
# Fake `gh` for adapter tests. Dispatches on argv and prints canned JSON.
# Records every invocation to $FAKE_GH_LOG (one line per call) so tests can assert.
set -uo pipefail
[[ -n "${FAKE_GH_LOG:-}" ]] && printf '%s\n' "$*" >> "$FAKE_GH_LOG"

case "$1 ${2:-}" in
  "issue view")
    echo '{"number":7,"title":"T","body":"B","labels":[{"name":"bug"}]}' ;;
  "pr view")
    echo '{"number":5,"url":"https://x/pr/5","state":"OPEN","headRefName":"feat-x"}' ;;
  "api graphql")
    # resolveReviewThread query or mutation — return minimal success
    echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"T_1","isResolved":false,"comments":{"nodes":[{"databaseId":9001}]}}]}}}}}' ;;
  "api"*)
    # REST: pulls/.../comments listing
    echo '[{"id":9001,"path":"a.ts","line":3,"user":{"login":"octocat"},"body":"fix","created_at":"2026-06-04T00:00:00Z","in_reply_to_id":null}]' ;;
  "pr create")
    echo "https://github.com/o/r/pull/99" ;;
  "issue edit")
    : ;;  # label edit, no output
  *)
    echo "unhandled args: $*" >&2; exit 64 ;;
esac
