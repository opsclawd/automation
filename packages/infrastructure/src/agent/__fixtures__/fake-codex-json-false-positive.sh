#!/usr/bin/env bash
set -euo pipefail
echo '{"type":"thread.started"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"In run e28a29d9, we saw an HTTP 429 error and Usage limit reached. However, this is just prose."}}'
echo '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}'
exit 0
