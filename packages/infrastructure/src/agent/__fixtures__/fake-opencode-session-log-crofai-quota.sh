#!/usr/bin/env bash
set -euo pipefail
# Simulates crofai credit exhaustion: exits 0, no stdout, no stderr.
# Writes a session log file with quota error so post-exit scan detects it.
# Reads OPENCODE_SESSION_LOG_DIR env var; if set, writes log there.
if [ -n "${OPENCODE_SESSION_LOG_DIR:-}" ]; then
  mkdir -p "$OPENCODE_SESSION_LOG_DIR"
  cat > "$OPENCODE_SESSION_LOG_DIR/2026-06-03T120000.log" <<'LOG'
INFO  2026-06-03T12:00:00.000Z +0ms service=llm msg=start
ERROR 2026-06-03T12:00:04.000Z +0ms service=llm {"error":{"code":401,"message":"Not Enough Credits","type":"unauthorized"}}
LOG
fi
exit 0
