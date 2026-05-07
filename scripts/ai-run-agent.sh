#!/usr/bin/env bash
set -euo pipefail

AI_CLI="${AI_CLI:-opencode}"
AI_MODEL="${AI_MODEL:-minimax/m2.7}"

PROMPT_FILE="$1"

if [[ -z "$PROMPT_FILE" ]]; then
  echo "Usage: $0 <prompt-file>" >&2
  exit 1
fi

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

if [[ -z "$AI_MODEL" ]]; then
  echo "Error: AI_MODEL is required" >&2
  exit 1
fi

case "$AI_CLI" in
  opencode)
    opencode --model "$AI_MODEL" run "$(cat "$PROMPT_FILE")"
    ;;
  *)
    echo "Error: unsupported AI_CLI '$AI_CLI'. Currently only 'opencode' is supported." >&2
    exit 1
    ;;
esac
