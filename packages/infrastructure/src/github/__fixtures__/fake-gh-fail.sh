#!/usr/bin/env bash
set -uo pipefail
echo 'HTTP 503: Service Unavailable (https://api.github.com)' >&2
exit 1
