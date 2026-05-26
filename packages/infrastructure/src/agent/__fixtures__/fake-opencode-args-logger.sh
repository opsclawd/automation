#!/usr/bin/env bash
set -euo pipefail
echo "$@" > "$(dirname "$0")/last-args.txt"
echo "fake opencode success" >&1
echo "no errors" >&2
exit 0