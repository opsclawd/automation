#!/usr/bin/env bash
set -euo pipefail
cat > /dev/null
cat << 'JSON'
{"event":"init","conversation_id":"f1c6db52-964f-44e8-82cc-d320cd8d4bb4","init":{"cwd":"/workspace","tools":["manage_task"]}}
{"event":"step_update","step_update":{"conversation_id":"f1c6db52-964f-44e8-82cc-d320cd8d4bb4","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"f1c6db52-964f-44e8-82cc-d320cd8d4bb4","step_index":1,"state":"DONE","step_type":"tool","tool_name":"manage_task","output":"Task: .../task-44\nStatus: RUNNING\nLog: .../task-44.log\nLog output:\n<truncated 13919 lines>\n...✓ maps HTTP 429 to retryable_failure\r\n ✓ maps HTTP 500 to retryable_failure\r\n ✓ maps HTTP 403 content_policy_violation to safety_refusal\r\n...\n\nLast progress: 0s ago\n"}}
{"event":"step_update","step_update":{"conversation_id":"f1c6db52-964f-44e8-82cc-d320cd8d4bb4","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"All tests passing.\n","duration_seconds":1.0,"usage":{"input_tokens":100,"output_tokens":10}}}
{"event":"result","result":{"conversation_id":"f1c6db52-964f-44e8-82cc-d320cd8d4bb4","status":"SUCCESS","response":"All tests passing.\n","duration_seconds":2.5,"num_turns":1,"usage":{"input_tokens":5000,"output_tokens":50,"thinking_tokens":20,"cache_read_tokens":10,"total_tokens":5050}}}
JSON
exit 0
