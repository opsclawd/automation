#!/usr/bin/env bash
set -euo pipefail
echo 'ERROR 2026-05-28T22:51:15.000Z +0ms service=llm {"name":"AI_APICallError","url":"https://api.example.com/v1/chat/completions","statusCode":500}' >&2
exit 1