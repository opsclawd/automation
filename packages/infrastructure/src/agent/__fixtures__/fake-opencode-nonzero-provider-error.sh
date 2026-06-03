#!/usr/bin/env bash
set -euo pipefail
echo '{"name":"AI_APICallError","url":"https://api.example.com/v1/chat/completions","statusCode":500}' >&2
exit 1
