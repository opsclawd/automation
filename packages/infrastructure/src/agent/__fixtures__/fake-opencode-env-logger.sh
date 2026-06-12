#!/usr/bin/env bash
set -euo pipefail
out="$(dirname "$0")/last-env.txt"
{
  echo "PWD=${PWD:-<unset>}"
  echo "INIT_CWD=${INIT_CWD:-<unset>}"
} > "$out"

cat > "$(dirname "$0")/last-stdin.txt"
echo "fake opencode success" >&1
echo "no errors" >&2
exit 0
