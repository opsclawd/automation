#!/usr/bin/env bash
# consolidate_helpers.sh — helpers for ai-consolidate-compound.
# Sourced by the main script and by bats tests.
#
# NOTE: log() and warn() are defined by the sourcing script (ai-consolidate-compound),
# not in this file. Callers may use echo directly. If sourcing standalone (e.g. in
# tests), log/warn are not available.

# Portability stubs — overridden by the sourcing script when present.
log()  { echo "$*"; }
warn() { echo "WARN: $*" >&2; }

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
# LIMITATION (auto / --since mode): Filesystem mtime (stat -c %Y) is compared
# against git committer timestamp (git log -1 --format=%ct). These clocks can
# diverge — git checkout, clone, cp -a, or backup/restore can reset mtime to a
# value that no longer corresponds to when the file was written. In practice this
# is acceptable for a developer-run, manually-triggered consolidation tool. For
# CI automation, prefer --issues to pin exact paths.
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
              find ai/ -path '*/poll-pr-*/compound-*.md' -type f 2>/dev/null) || true

  if [[ -z "$since_ref" ]]; then
    echo "$all_files" | sed -n '/^$/!p' | sort
    return 0
  fi

  # filter to files modified after since_ref via mtime comparison
  local since_epoch
  since_epoch=$(git log -1 --format=%ct "$since_ref" 2>/dev/null) || {
    warn "Invalid --since ref: '${since_ref}'. Use a valid commit, tag, or branch name."
    return 2
  }
  echo "$all_files" | sed -n '/^$/!p' | while IFS= read -r f; do
    local mtime
    mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
    if [[ "$mtime" -gt "$since_epoch" ]]; then
      echo "$f"
    fi
  done | sort
}

# diff_and_confirm — show the working-tree diff under docs/solutions/ and ask
# the user to confirm. Returns 0 on yes, 1 on no, 0 with a note when nothing
# changed (so the caller can exit clean on a zero-output run).
#
# NOTE: Interactive confirmation reads from stdin (fd 0). In piping/CI contexts
# use --yes instead, which skips the prompt and commits directly.
diff_and_confirm() {
  cd "$REPO_ROOT" || return 1
  if git diff --quiet -- docs/solutions/ && [[ -z "$(git status --porcelain -- docs/solutions/)" ]]; then
    echo "Nothing to commit under docs/solutions/."
    return 0
  fi
  echo "--- Proposed changes under docs/solutions/ ---"
  git status --short -- docs/solutions/
  echo
  git diff HEAD -- docs/solutions/
  echo
  read -r -p "Commit these changes? [y/N] " answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# commit_consolidation — stage docs/solutions/ and commit with a standard
# message. Caller is responsible for having run diff_and_confirm first.
commit_consolidation() {
  cd "$REPO_ROOT" || return 1
  if git diff --quiet -- docs/solutions/ && [[ -z "$(git status --porcelain -- docs/solutions/)" ]]; then
    return 0
  fi
  git add docs/solutions/
  git commit -m "docs(solutions): consolidate compound artifacts

Curated from ai/issues/*/compound.md and ai/poll-pr-*/compound-*.md." \
    -- docs/solutions/
}
