#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
printf '%s' '{"conversation_id":"22222222-2222-2222-2222-222222222222","status":"SUCCESS","response":"","duration_seconds":0.5,"num_turns":1,"usage":{"input_tokens":100,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":100}}'
exit 0
