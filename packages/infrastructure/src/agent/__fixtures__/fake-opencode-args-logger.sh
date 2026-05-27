#!/usr/bin/env bash
set -euo pipefail
echo "$@" > "$(dirname "$0")/last-args.txt"
cat > "$(dirname "$0")/last-stdin.txt"
echo "fake opencode success" >&1
echo "no errors" >&2
exit 0