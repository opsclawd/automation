#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
echo 'RESOURCE_EXHAUSTED (code 429): Individual quota reached' >&2
exit 0
