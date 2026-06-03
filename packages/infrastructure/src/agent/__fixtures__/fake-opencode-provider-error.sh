#!/usr/bin/env bash
set -euo pipefail
echo '{"name":"AI_APICallError","url":"https://crof.ai/v1/chat/completions","statusCode":500}' >&2
exit 0
