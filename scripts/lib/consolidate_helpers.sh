#!/usr/bin/env bash
# consolidate_helpers.sh — helpers for ai-consolidate-compound.
# Sourced by the main script and by bats tests.

# discover_inputs — emit one path per line of compound files that should be
# considered for this consolidation pass.
#
# Modes (mutually exclusive):
#   discover_inputs                — all compound files newer than the newest
#                                    commit touching docs/solutions/ (or all
#                                    files if no such commit exists)
#   discover_inputs --since <ref>  — all compound files newer than <ref>
#   discover_inputs --issues a,b,c — only ai/issues/<a>/compound.md etc.
#                                    (poll-pr files excluded in issue mode)
#
# Requires REPO_ROOT to be set.
discover_inputs() {
  local mode=auto since_ref="" issues=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --since) mode=since; since_ref="$2"; shift 2 ;;
      --issues) mode=issues; issues="$2"; shift 2 ;;
      *) echo "discover_inputs: unknown arg $1" >&2; return 2 ;;
    esac
  done

  cd "$REPO_ROOT" || return 1

  if [[ "$mode" == "issues" ]]; then
    local IFS=','
    for n in $issues; do
      [[ -f "ai/issues/${n}/compound.md" ]] && echo "ai/issues/${n}/compound.md"
    done
    return 0
  fi

  # auto: resolve the since-ref from git log on docs/solutions/
  if [[ "$mode" == "auto" ]]; then
    since_ref=$(git log -1 --format=%H -- docs/solutions/ 2>/dev/null || echo "")
  fi

  local all_files
  all_files=$(find ai/issues -name 'compound.md' -type f 2>/dev/null; \
              find ai/poll-pr-* -name 'compound-*.md' -type f 2>/dev/null) || true

  if [[ -z "$since_ref" ]]; then
    echo "$all_files" | grep -v '^$' | sort
    return 0
  fi

  # filter to files modified after since_ref via mtime comparison
  local since_epoch
  since_epoch=$(git log -1 --format=%ct "$since_ref" 2>/dev/null || echo 0)
  echo "$all_files" | grep -v '^$' | while IFS= read -r f; do
    local mtime
    mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
    if [[ "$mtime" -gt "$since_epoch" ]]; then
      echo "$f"
    fi
  done | sort
}
