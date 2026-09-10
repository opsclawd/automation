#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
cat << 'JSON'
{"event":"init","conversation_id":"11111111-1111-1111-1111-111111111111","init":{"cwd":"/tmp","tools":[]}}
{"event":"step_update","step_update":{"conversation_id":"11111111-1111-1111-1111-111111111111","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"11111111-1111-1111-1111-111111111111","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"PONG\n","duration_seconds":1.0,"usage":{"input_tokens":100,"output_tokens":10}}}
{"event":"result","result":{"conversation_id":"11111111-1111-1111-1111-111111111111","status":"SUCCESS","response":"PONG\n","duration_seconds":1.23,"num_turns":1,"usage":{"input_tokens":14633,"output_tokens":55,"thinking_tokens":53,"cache_read_tokens":7,"total_tokens":14688}}}
JSON
exit 0
