#!/usr/bin/env bash
set -euo pipefail
echo "$@" > "$(dirname "$0")/agy-last-args.txt"
cat > "$(dirname "$0")/agy-last-stdin.txt"
echo "fake agy success" >&1
echo "no errors" >&2
exit 0