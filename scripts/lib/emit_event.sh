#!/usr/bin/env bash
# scripts/lib/emit_event.sh
# Append a single JSON event line to $AI_RUN_EVENTS_FILE.
#
# Usage:
#   emit_event <phase> <level> <type> <message> [k=v ...]
#
# - <phase> may be the empty string for run-level events; the field is omitted.
# - <level> is one of: info | warn | error.
# - <type>  is a dotted name (e.g. phase.started, artifact.created).
# - <message> is a human-readable string.
# - k=v pairs become a JSON object under "metadata"; numeric-looking values
#   become numbers, everything else becomes a string.
#
# Env:
#   AI_RUN_EVENTS_FILE — absolute path to the events file. If unset/empty,
#                        emit_event is a no-op (returns 0) so legacy scripts
#                        remain runnable standalone.
#   AI_RUN_DISPLAY_ID  — required when AI_RUN_EVENTS_FILE is set; the run's
#                        displayId (e.g. issue-123-20260516-120000).
#
# Atomicity: a single `printf "%s\n" >> "$f"` on POSIX is a single write(2)
# for sub-PIPE_BUF payloads, so concurrent writers from the same script do not
# interleave bytes within a line. Keep payloads modest.
# Guard: allow `source emit_event.sh` from scripts that use `set -u`.
: "${AI_RUN_EVENTS_FILE:=}"
: "${AI_RUN_DISPLAY_ID:=}"

_emit_event_have_jq() {
  command -v jq >/dev/null 2>&1
}

# Pure-Bash JSON string escape (fallback when jq missing).
# Handles: backslash, double-quote, control chars (\b \f \n \r \t),
# other 0x00-0x1f via \u00XX.
_json_escape() {
  local s=$1
  local out=""
  local i ch code
  for ((i = 0; i < ${#s}; i++)); do
    ch=${s:i:1}
    case "$ch" in
      '\') out+='\\' ;;
      '"') out+='\"' ;;
      $'\b') out+='\b' ;;
      $'\f') out+='\f' ;;
      $'\n') out+='\n' ;;
      $'\r') out+='\r' ;;
      $'\t') out+='\t' ;;
      *)
        printf -v code '%d' "'$ch"
        if (( code < 0x20 )); then
          printf -v out '%s\\u%04x' "$out" "$code"
        else
          out+=$ch
        fi
        ;;
    esac
  done
  printf '%s' "$out"
}

# Build the metadata JSON object from k=v pairs in $@.
# With jq: numeric-looking values become JSON numbers, true/false/null become
# those literals, everything else becomes a string.
# Without jq: all values become JSON strings (no type inference).
_emit_event_metadata() {
  if _emit_event_have_jq; then
    if [[ $# -eq 0 ]]; then
      printf '{}'
      return
    fi
    local args=() pair k v
    for pair in "$@"; do
      k=${pair%%=*}
      v=${pair#*=}
      args+=(--arg "k_$k" "$v")
    done
    local jq_obj="{"
    local first=1
    for pair in "$@"; do
      k=${pair%%=*}
      [[ $first -eq 1 ]] || jq_obj+=","
      jq_obj+="\"$k\": (\$k_$k | (tonumber? // (if . == \"true\" then true elif . == \"false\" then false elif . == \"null\" then null else . end)))"
      first=0
    done
    jq_obj+="}"
    jq -nc "${args[@]}" "$jq_obj"
  else
    if [[ $# -eq 0 ]]; then
      printf '{}'
      return
    fi
    local out="{" first=1 pair k v esc
    for pair in "$@"; do
      k=${pair%%=*}
      v=${pair#*=}
      esc=$(_json_escape "$v")
      [[ $first -eq 1 ]] || out+=","
      out+="\"$(_json_escape "$k")\":\"$esc\""
      first=0
    done
    out+="}"
    printf '%s' "$out"
  fi
}

emit_event() {
  local phase=${1:-}
  local level=${2:-info}
  local type=${3:-event}
  local message=${4:-}
  shift 4 || true

  if [[ -z "$AI_RUN_EVENTS_FILE" ]]; then
    return 0
  fi
  if [[ -z "$AI_RUN_DISPLAY_ID" ]]; then
    printf 'emit_event: AI_RUN_DISPLAY_ID is unset, skipping\n' >&2
    return 0
  fi

  local timestamp
  if date --version >/dev/null 2>&1; then
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  else
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  fi

  local metadata
  metadata=$(_emit_event_metadata "$@")

  local line
  if _emit_event_have_jq; then
    local jq_args=(
      --arg runId "$AI_RUN_DISPLAY_ID"
      --arg level "$level"
      --arg type "$type"
      --arg message "$message"
      --arg timestamp "$timestamp"
      --argjson metadata "$metadata"
    )
    local jq_filter='{runId: $runId, level: $level, type: $type, message: $message, timestamp: $timestamp, metadata: $metadata}'
    if [[ -n "$phase" ]]; then
      jq_args+=(--arg phase "$phase")
      jq_filter='{runId: $runId, phase: $phase, level: $level, type: $type, message: $message, timestamp: $timestamp, metadata: $metadata}'
    fi
    line=$(jq -nc "${jq_args[@]}" "$jq_filter")
  else
    local esc_msg esc_runid esc_phase esc_type esc_level
    esc_msg=$(_json_escape "$message")
    esc_runid=$(_json_escape "$AI_RUN_DISPLAY_ID")
    esc_type=$(_json_escape "$type")
    esc_level=$(_json_escape "$level")
    if [[ -n "$phase" ]]; then
      esc_phase=$(_json_escape "$phase")
      line="{\"runId\":\"$esc_runid\",\"phase\":\"$esc_phase\",\"level\":\"$esc_level\",\"type\":\"$esc_type\",\"message\":\"$esc_msg\",\"timestamp\":\"$timestamp\",\"metadata\":$metadata}"
    else
      line="{\"runId\":\"$esc_runid\",\"level\":\"$esc_level\",\"type\":\"$esc_type\",\"message\":\"$esc_msg\",\"timestamp\":\"$timestamp\",\"metadata\":$metadata}"
    fi
  fi

  # Single append-write. Errors warn to stderr, never abort the caller.
  if ! printf '%s\n' "$line" >> "$AI_RUN_EVENTS_FILE" 2>/dev/null; then
    printf 'emit_event: failed to append to %s\n' "$AI_RUN_EVENTS_FILE" >&2
  fi
}