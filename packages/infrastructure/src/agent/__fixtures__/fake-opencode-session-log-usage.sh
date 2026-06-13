#!/usr/bin/env bash
# Fixture: writes a session log with token usage lines, then exits 0.
# opencode writes its session logs to XDG_DATA_HOME/opencode/log. The
# adapter sets OPENCODE_SESSION_LOG_DIR so fixtures know where to write.
set -euo pipefail
log_dir="${OPENCODE_SESSION_LOG_DIR:-/tmp}"
log_file="${log_dir}/session-$RANDOM.log"
cat > "$log_file" <<'EOLOG'
INFO  2026-06-03T12:00:01.000Z +0ms service=llm tokens={"input":1234,"output":567,"cacheRead":42}
INFO  2026-06-03T12:00:02.000Z +0ms service=llm tokens={"input":100,"output":50}
EOLOG
echo "fake opencode success with session log" >&1
exit 0
