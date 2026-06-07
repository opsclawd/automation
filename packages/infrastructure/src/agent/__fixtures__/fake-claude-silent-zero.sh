#!/usr/bin/env bash
set -euo pipefail
# Simulates silent zero-exit: no stdout, no stderr, exit 0
cat > /dev/null
exit 0
