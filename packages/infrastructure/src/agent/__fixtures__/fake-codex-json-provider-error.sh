#!/usr/bin/env bash
set -euo pipefail
echo '{"type":"thread.started"}'
echo '{"type":"turn.started"}'
echo '{"type":"error","message":"{\"type\":\"error\",\"status\":503,\"error\":{\"type\":\"service_unavailable\",\"message\":\"Overloaded\"}}"}'
exit 1
