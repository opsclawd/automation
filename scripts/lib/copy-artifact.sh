#!/usr/bin/env bash
# scripts/lib/copy-artifact.sh
#
# Persist a phase artifact to its destination, tolerating the common case where
# source and destination are the same file.
#
# In the issue-to-PR orchestrator ISSUES_DIR == WORKTREE_DIR, so "persist to
# ISSUES_DIR" copies of files the agent already wrote to WORKTREE_DIR are
# self-copies. `cp X X` errors with "are the same file" and aborts the run, even
# though there is nothing to do (this broke the review-triage phase). Skip the
# copy when both paths resolve to the same file (-ef); copy normally otherwise,
# so the call still works if ISSUES_DIR ever diverges from WORKTREE_DIR.

_copy_if_distinct() {
  local src="$1" dest="$2"
  [[ "$src" -ef "$dest" ]] && return 0
  cp "$src" "$dest"
}
