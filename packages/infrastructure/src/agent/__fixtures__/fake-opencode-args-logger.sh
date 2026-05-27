#!/usr/bin/env bash
set -euo pipefail
# Logs argv and stdin. Requires stdin to be closed (i.e., input must be
# provided via execa's `input` option); otherwise `cat` will hang.
echo "$@" > "$(dirname "$0")/last-args.txt"
cat > "$(dirname "$0")/last-stdin.txt"
echo "fake opencode success" >&1
echo "no errors" >&2
exit 0