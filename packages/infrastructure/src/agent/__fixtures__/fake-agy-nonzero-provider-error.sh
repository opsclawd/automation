#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
echo 'AI_APICallError: upstream returned 500' >&2
exit 1