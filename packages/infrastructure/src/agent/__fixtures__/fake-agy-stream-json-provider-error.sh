#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
cat << 'JSON'
{"event":"init","conversation_id":"22222222-2222-2222-2222-222222222222","init":{"cwd":"/workspace","tools":[]}}
{"event":"step_update","step_update":{"conversation_id":"22222222-2222-2222-2222-222222222222","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"result","result":{"conversation_id":"22222222-2222-2222-2222-222222222222","status":"ERROR","error":"API call failed after 3 retries: HTTP 429: Token Plan usage limit reached","response":"","duration_seconds":0.5,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}
JSON
exit 0
