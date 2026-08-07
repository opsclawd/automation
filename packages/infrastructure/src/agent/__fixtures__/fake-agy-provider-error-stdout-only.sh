#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' \
  '## Response' \
  'API call failed after 3 retries: HTTP 429: Token Plan usage limit reached:' \
  'Upgrade your Token Plan or purchase Credits for more usage. (2056)'
exit 0