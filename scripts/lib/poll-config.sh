#!/usr/bin/env bash
# Resolve post-PR review poll settings from an .ai-orchestrator config file.
# Sourced by ai-run-issue-v2 (and bats tests).

# resolve_pr_review_poll_settings <config_file> [default_polls] [default_interval]
# Echoes "<maxPolls> <pollIntervalSeconds>", each read from
# phases.postPrReview.{maxPolls,pollIntervalSeconds}. Falls back to the defaults
# (3 / 300) on a missing file, missing key, or non-positive-integer value, so a
# malformed config can never shrink the poll budget to zero or a bogus value.
resolve_pr_review_poll_settings() {
  local config_file="$1"
  local polls="${2:-3}"
  local interval="${3:-300}"
  local _v
  if [[ -n "$config_file" && -f "$config_file" ]]; then
    _v=$(jq -r '.phases.postPrReview.maxPolls // empty' "$config_file" 2>/dev/null) || _v=""
    [[ "$_v" =~ ^[1-9][0-9]*$ ]] && polls="$_v"
    _v=$(jq -r '.phases.postPrReview.pollIntervalSeconds // empty' "$config_file" 2>/dev/null) || _v=""
    [[ "$_v" =~ ^[1-9][0-9]*$ ]] && interval="$_v"
  fi
  printf '%s %s\n' "$polls" "$interval"
}
