#!/usr/bin/env bash
set -euo pipefail
output_dir="${AGY_LOG_DIR:-"$(dirname "$0")"}"
echo "$@" > "$output_dir/agy-last-args.txt"
cat > "$output_dir/agy-last-stdin.txt"
echo "fake agy success" >&1
echo "no errors" >&2
exit 0
