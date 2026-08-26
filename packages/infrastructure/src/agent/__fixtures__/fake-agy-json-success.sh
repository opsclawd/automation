#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
printf '%s' '{"conversation_id":"11111111-1111-1111-1111-111111111111","status":"SUCCESS","response":"PONG\n","duration_seconds":1.23,"num_turns":1,"usage":{"input_tokens":14633,"output_tokens":55,"thinking_tokens":53,"cache_read_tokens":7,"total_tokens":14688}}'
exit 0
