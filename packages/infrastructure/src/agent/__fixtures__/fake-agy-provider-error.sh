#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
echo 'RESOURCE_EXHAUSTED (HTTP 429): Individual quota reached' >&2
exit 0
