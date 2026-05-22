---
title: Bash emit_event helper patterns — jq-first, atomic appends, no-op contract
date: 2026-05-17
category: orchestration
module: scripts/lib
problem_type: pattern
component: emit_event
symptoms:
  - No structured event stream from Bash scripts
  - Events needed for real-time UI and phase timeline
root_cause: missing_infrastructure
resolution_type: new_feature
severity: medium
related_components:
  - scripts/lib/emit_event.sh
  - scripts/ai-run-issue-v2
  - scripts/ai-pr-review-poll
tags:
  - bash
  - events
  - jsonl
  - jq
  - atomic
  - noop-contract
---

# Bash emit_event helper patterns

## Core Design

The `emit_event.sh` helper appends one JSON line per call to `AI_RUN_EVENTS_FILE`. It is:

- **No-op when `AI_RUN_EVENTS_FILE` is unset** — scripts work standalone without the wrapper
- **Resilient under `set -euo pipefail`** — returns 0 always, never aborts caller
- **Atomic on Linux** — single `write(2)` under `PIPE_BUF` (4096 bytes)

## Key Patterns

### jq variable name sanitization

`jq` variable names must match `[a-zA-Z_][a-zA-Z0-9_]*`. Metadata keys like `exit-code` or `phase.type` are valid JSON keys but invalid as `jq --arg` names.

```bash
# Sanitize: my-key → my_key, 1abc → _1abc
_sanitize_jq_ident() {
  local raw="$1"
  local cleaned="${raw//[^a-zA-Z0-9_]/_}"
  if [[ "$cleaned" =~ ^[0-9] ]]; then
    cleaned="_${cleaned}"
  fi
  echo "v_${cleaned}"
}
```

The original key (e.g., `"my-key"`) is preserved in JSON output; only the `jq` variable name is sanitized.

### Pure-Bash fallback for JSON escaping

When `jq` is unavailable, a pure-Bash escaper handles `\`, `"`, and control chars:

```bash
_json_escape() {
  local str="$1"
  str="${str//\\/\\\\}"
  str="${str//\"/\\\"}"
  printf '%s' "$str"
}
```

Values with `jq` get numeric inference (numbers become JSON numbers); without `jq`, all values are strings. This is acceptable because the fallback is rare.

### Atomic append via printf

```bash
printf '%s\n' "$line" >> "$file"
```

On Linux, a single `write(2)` under `PIPE_BUF` (4096 bytes) is atomic. Event lines are 200-500 bytes, well under the limit. No `flock` needed for single-writer scenarios.

### Empty-line guard

```bash
if [[ -z "$line" ]]; then
  echo "emit_event: empty line, skipping" >&2
  return 0
fi
```

Prevents blank lines in the events file if metadata parsing produces nothing.

### nohup env var prefix pattern

When spawning background processes via `nohup`, always prefix env vars explicitly:

```bash
nohup \
  AI_RUN_EVENTS_FILE="${AI_RUN_EVENTS_FILE:-}" \
  AI_RUN_DISPLAY_ID="${AI_RUN_DISPLAY_ID:-}" \
  "$script" \
  > /dev/null 2>&1 &
```

`nohup` does not reliably forward exported vars on all platforms. `${VAR:-}` defaults to empty string when unset, which `emit_event` handles as a no-op.

### `set -u` safety inside sourced functions

Even when the parent script uses `set -u`, vars might be explicitly unset. Use `${VAR:-}` inside functions:

```bash
# At top of sourced file (works for normal case):
: "${AI_RUN_EVENTS_FILE:=}"

# Inside emit_event function (defensive for edge cases):
local events_file="${AI_RUN_EVENTS_FILE:-}"
```

### k=v metadata parsing

Metadata is passed as `k=v` pairs after positional args:

```bash
emit_event "plan-write" "info" "phase.started" "starting plan" cmd="pnpm build" exitCode=2
```

Split on `=` using `pair#*=` (first match only), so values containing `=` are preserved:

```bash
local key="${pair%%=*}"
local val="${pair#*=}"
```

## Running Tests

```bash
pnpm test:bash
# or directly:
bats scripts/lib/__tests__/emit_event.bats
```

## Adding Call Sites

The helper is sourced but not yet called from orchestrator scripts. To add calls:

```bash
emit_event "plan-write" "info" "phase.started" "starting plan write"
emit_event "" "info" "run.started" "run started"
emit_event "validate" "error" "phase.failed" "build failed" command="pnpm build" exitCode=2
```

`phase` is omitted entirely when called with empty string. `metadata` is always an object (defaults to `{}`).

## Event JSON Shape

```json
{
  "runId": "issue-123-20260516-120000",
  "phase": "plan-write",
  "level": "info",
  "type": "phase.started",
  "message": "starting plan write phase",
  "timestamp": "2026-05-16T12:00:00.123Z",
  "metadata": { "command": "pnpm build", "exitCode": 2 }
}
```
