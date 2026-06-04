#!/usr/bin/env bash
set -euo pipefail
# Simulates provider error in session log only: exits 0, no stdout, no stderr.
# Writes a session log file with provider error so post-exit scan detects it.
# Reads OPENCODE_SESSION_LOG_DIR env var; if set, writes log there.
if [ -n "${OPENCODE_SESSION_LOG_DIR:-}" ]; then
  mkdir -p "$OPENCODE_SESSION_LOG_DIR"
  cat > "$OPENCODE_SESSION_LOG_DIR/2026-06-03T120000.log" <<'LOG'
INFO  2026-06-03T12:00:00.000Z +0ms service=llm msg=start
ERROR 2026-06-03T12:00:04.000Z +0ms service=llm {"name":"AI_APICallError","url":"https://example.com","statusCode":500}
LOG
fi
exit 0
