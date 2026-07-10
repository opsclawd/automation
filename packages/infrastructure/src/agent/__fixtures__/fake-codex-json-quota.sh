#!/usr/bin/env bash
set -euo pipefail
echo '{"type":"thread.started"}'
echo '{"type":"turn.started"}'
echo '{"type":"error","message":"{\"type\":\"error\",\"status\":429,\"error\":{\"type\":\"insufficient_quota\",\"message\":\"Quota exceeded\"}}"}'
echo '{"type":"turn.failed","error":{"message":"{\"status\":429}"}}'
exit 1
