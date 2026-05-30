#!/usr/bin/env bash
set -euo pipefail
stdin_content=$(cat)
echo "fake agy success: OK (stdin ${#stdin_content} chars)" >&1
echo "no errors" >&2
exit 0