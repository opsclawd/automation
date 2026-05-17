# M2-01: Bash `emit_event` Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable Bash helper that appends a single, strictly-formed JSON line to an events file, sourced by both legacy scripts.

**Architecture:** A new `scripts/lib/emit_event.sh` exports `emit_event` and a JSON escaper. Both `scripts/ai-run-issue-v2` and `scripts/ai-pr-review-poll` source it near the top. Output target is the path in `$AI_RUN_EVENTS_FILE` (set by the Node wrapper; if unset the helper is a no-op so the scripts remain runnable standalone). Validation uses `jq` if present, otherwise a pure-Bash JSON string escaper.

**Tech Stack:** Bash 5.x, `jq` (optional), `bats-core` for tests (already widely available; install via the test step if missing).

---

## File Structure

- **Create:** `scripts/lib/emit_event.sh` — the helper (`emit_event`, `_json_escape`).
- **Modify:** `scripts/ai-run-issue-v2` — `source "$REPO_ROOT/scripts/lib/emit_event.sh"` (no `emit_event` calls yet; that's M2-02).
- **Modify:** `scripts/ai-pr-review-poll` — `source "$REPO_ROOT/scripts/lib/emit_event.sh"` (no calls yet; M2-03 adds them).
- **Create:** `scripts/lib/__tests__/emit_event.bats` — bats tests.
- **Modify:** `package.json` — add `"test:bash": "bats scripts/lib/__tests__"` script if no equivalent exists.

Sourcing without calling means M2-01 is safe to ship before M2-02/03.

---

## Background context for the implementer

- `events.jsonl` is one JSON object per line. Schema (from PRD §16.2.4):
  ```json
  {
    "runId": "...",
    "phase": "...",
    "level": "info",
    "type": "phase.started",
    "message": "...",
    "timestamp": "2026-05-16T12:00:00.000Z",
    "metadata": {}
  }
  ```
- `phase` is optional (run-level events omit it).
- `timestamp` is ISO 8601 UTC with millisecond precision.
- `runId` here is the **displayId** (e.g. `issue-123-20260516-120000`), not the UUID. The wrapper passes it via `AI_RUN_DISPLAY_ID`.
- The helper must never crash its caller. Failures to write are warned to stderr, not fatal.
- `set -euo pipefail` is on in the run script. The helper must not introduce unbound-variable errors.

---

## Task 1: Create the helper module

**Files:**

- Create: `scripts/lib/emit_event.sh`

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/__tests__/emit_event.bats`:

```bash
#!/usr/bin/env bats

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  export AI_RUN_EVENTS_FILE="${TMPDIR_TEST}/events.jsonl"
  export AI_RUN_DISPLAY_ID="issue-1-20260516-120000"
  # shellcheck source=../emit_event.sh
  source "${BATS_TEST_DIRNAME}/../emit_event.sh"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "emit_event writes a single valid JSON line" {
  emit_event "plan-write" "info" "phase.started" "starting plan write"
  run cat "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
  [ "$(wc -l < "$AI_RUN_EVENTS_FILE")" -eq 1 ]
  echo "$output" | jq -e '.runId == "issue-1-20260516-120000"' >/dev/null
  echo "$output" | jq -e '.phase == "plan-write"' >/dev/null
  echo "$output" | jq -e '.level == "info"' >/dev/null
  echo "$output" | jq -e '.type == "phase.started"' >/dev/null
  echo "$output" | jq -e '.message == "starting plan write"' >/dev/null
  echo "$output" | jq -e '.timestamp | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")' >/dev/null
  echo "$output" | jq -e '.metadata == {}' >/dev/null
}

@test "emit_event escapes quotes, backslashes, newlines in message" {
  emit_event "review" "error" "phase.failed" $'line1\n"quoted"\\backslash'
  run jq -r '.message' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
  [ "$output" = $'line1\n"quoted"\\backslash' ]
}

@test "emit_event accepts k=v metadata pairs and emits structured metadata" {
  emit_event "validate" "error" "phase.failed" "build failed" command="pnpm build" exitCode=2
  run jq -e '.metadata.command == "pnpm build" and (.metadata.exitCode | tonumber) == 2' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "emit_event omits phase when called with empty phase" {
  emit_event "" "info" "run.started" "starting run"
  run jq -e 'has("phase") | not' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
}

@test "emit_event is a no-op when AI_RUN_EVENTS_FILE is unset" {
  unset AI_RUN_EVENTS_FILE
  run emit_event "plan-write" "info" "phase.started" "ignored"
  [ "$status" -eq 0 ]
}

@test "emit_event appends, never truncates" {
  emit_event "p" "info" "a" "first"
  emit_event "p" "info" "b" "second"
  [ "$(wc -l < "$AI_RUN_EVENTS_FILE")" -eq 2 ]
}

@test "concurrent writers do not interleave bytes within a line" {
  for i in 1 2 3 4 5 6 7 8 9 10; do
    emit_event "p" "info" "t" "msg-$i" idx=$i &
  done
  wait
  # Every line must be valid JSON
  while IFS= read -r line; do
    echo "$line" | jq -e '.message' >/dev/null
  done < "$AI_RUN_EVENTS_FILE"
  [ "$(wc -l < "$AI_RUN_EVENTS_FILE")" -eq 10 ]
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bats scripts/lib/__tests__/emit_event.bats`
Expected: FAIL — `scripts/lib/emit_event.sh` does not exist yet.

If `bats` is missing, install:

```bash
# Manjaro
sudo pacman -S --noconfirm bats
# or: pnpm dlx bats-core scripts/lib/__tests__/emit_event.bats
```

- [ ] **Step 3: Implement the helper**

Create `scripts/lib/emit_event.sh`:

```bash
#!/usr/bin/env bash
# scripts/lib/emit_event.sh
# Append a single JSON event line to $AI_RUN_EVENTS_FILE.
#
# Usage:
#   emit_event <phase> <level> <type> <message> [k=v ...]
#
# - <phase> may be the empty string for run-level events; the field is omitted.
# - <level> is one of: info | warn | error.
# - <type>  is a dotted name (e.g. phase.started, artifact.created).
# - <message> is a human-readable string.
# - k=v pairs become a JSON object under "metadata"; numeric-looking values
#   become numbers, everything else becomes a string.
#
# Env:
#   AI_RUN_EVENTS_FILE — required; absolute path to append-to.
#                        If unset/empty, this function is a no-op so the
#                        legacy scripts remain runnable standalone.
#   AI_RUN_DISPLAY_ID  — required when AI_RUN_EVENTS_FILE is set; the
#                        run's displayId (e.g. issue-123-20260516-120000).
#
# Atomicity: a single `printf "%s\n" >> "$f"` on POSIX is a single
# write(2) for sub-PIPE_BUF payloads, so concurrent writers from the same
# script do not interleave bytes within a line. Keep payloads modest.

# Guard: allow `source emit_event.sh` from scripts that use `set -u`.
: "${AI_RUN_EVENTS_FILE:=}"
: "${AI_RUN_DISPLAY_ID:=}"

_emit_event_have_jq() {
  command -v jq >/dev/null 2>&1
}

# Pure-Bash JSON string escape (fallback when jq missing).
# Handles: backslash, double-quote, control chars (\b \f \n \r \t),
# other 0x00-0x1f via \u00XX.
_json_escape() {
  local s=$1
  local out=""
  local i ch code
  for ((i = 0; i < ${#s}; i++)); do
    ch=${s:i:1}
    case "$ch" in
      '\') out+='\\' ;;
      '"') out+='\"' ;;
      $'\b') out+='\b' ;;
      $'\f') out+='\f' ;;
      $'\n') out+='\n' ;;
      $'\r') out+='\r' ;;
      $'\t') out+='\t' ;;
      *)
        printf -v code '%d' "'$ch"
        if (( code < 0x20 )); then
          printf -v out '%s\\u%04x' "$out" "$code"
        else
          out+=$ch
        fi
        ;;
    esac
  done
  printf '%s' "$out"
}

# Build the metadata JSON object from k=v pairs in $@.
# Numeric-looking values (`^-?[0-9]+(\.[0-9]+)?$`) emit as JSON numbers,
# `true`/`false`/`null` emit as those literals, everything else as a string.
_emit_event_metadata() {
  if _emit_event_have_jq; then
    local args=() pair k v
    for pair in "$@"; do
      k=${pair%%=*}
      v=${pair#*=}
      args+=(--arg "k_$k" "$v")
    done
    # Build with jq -n using --arg pairs. Simpler: pipe a constructed
    # object. We'll just use --arg for all values (strings); then post-
    # convert numbers/booleans/null with a small jq filter.
    local jq_obj="{"
    local first=1
    for pair in "$@"; do
      k=${pair%%=*}
      [[ $first -eq 1 ]] || jq_obj+=","
      jq_obj+="\"$k\": (\$k_$k | (tonumber? // (if . == \"true\" then true elif . == \"false\" then false elif . == \"null\" then null else . end)))"
      first=0
    done
    jq_obj+="}"
    if [[ $first -eq 1 ]]; then
      printf '{}'
    else
      jq -nc "${args[@]}" "$jq_obj"
    fi
  else
    # Fallback: best-effort, everything becomes a JSON string.
    local out="{" first=1 pair k v esc
    for pair in "$@"; do
      k=${pair%%=*}
      v=${pair#*=}
      esc=$(_json_escape "$v")
      [[ $first -eq 1 ]] || out+=","
      out+="\"$(_json_escape "$k")\":\"$esc\""
      first=0
    done
    out+="}"
    printf '%s' "$out"
  fi
}

emit_event() {
  local phase=${1:-}
  local level=${2:-info}
  local type=${3:-event}
  local message=${4:-}
  shift 4 || true

  if [[ -z "$AI_RUN_EVENTS_FILE" ]]; then
    return 0
  fi
  if [[ -z "$AI_RUN_DISPLAY_ID" ]]; then
    printf 'emit_event: AI_RUN_DISPLAY_ID is unset, skipping\n' >&2
    return 0
  fi

  local timestamp
  if date --version >/dev/null 2>&1; then
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  else
    timestamp=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  fi

  local metadata
  metadata=$(_emit_event_metadata "$@")

  local line
  if _emit_event_have_jq; then
    local jq_args=(
      --arg runId "$AI_RUN_DISPLAY_ID"
      --arg level "$level"
      --arg type "$type"
      --arg message "$message"
      --arg timestamp "$timestamp"
      --argjson metadata "$metadata"
    )
    local jq_filter='{runId: $runId, level: $level, type: $type, message: $message, timestamp: $timestamp, metadata: $metadata}'
    if [[ -n "$phase" ]]; then
      jq_args+=(--arg phase "$phase")
      jq_filter='{runId: $runId, phase: $phase, level: $level, type: $type, message: $message, timestamp: $timestamp, metadata: $metadata}'
    fi
    line=$(jq -nc "${jq_args[@]}" "$jq_filter")
  else
    local m esc_msg esc_runid esc_phase esc_type esc_level
    esc_msg=$(_json_escape "$message")
    esc_runid=$(_json_escape "$AI_RUN_DISPLAY_ID")
    esc_type=$(_json_escape "$type")
    esc_level=$(_json_escape "$level")
    if [[ -n "$phase" ]]; then
      esc_phase=$(_json_escape "$phase")
      line="{\"runId\":\"$esc_runid\",\"phase\":\"$esc_phase\",\"level\":\"$esc_level\",\"type\":\"$esc_type\",\"message\":\"$esc_msg\",\"timestamp\":\"$timestamp\",\"metadata\":$metadata}"
    else
      line="{\"runId\":\"$esc_runid\",\"level\":\"$esc_level\",\"type\":\"$esc_type\",\"message\":\"$esc_msg\",\"timestamp\":\"$timestamp\",\"metadata\":$metadata}"
    fi
  fi

  # Single append-write. Errors warn to stderr, never abort the caller.
  if ! printf '%s\n' "$line" >> "$AI_RUN_EVENTS_FILE" 2>/dev/null; then
    printf 'emit_event: failed to append to %s\n' "$AI_RUN_EVENTS_FILE" >&2
  fi
}
```

- [ ] **Step 4: Run the bats tests to verify pass**

Run: `bats scripts/lib/__tests__/emit_event.bats`
Expected: 7 passing tests.

If "concurrent writers" fails on your platform, lines longer than `PIPE_BUF` (4096 bytes on Linux) are not guaranteed atomic. The current test payloads are well under that. If it fails for other reasons, switch to `flock`:

```bash
exec 9>>"$AI_RUN_EVENTS_FILE.lock"; flock 9; printf ...; flock -u 9
```

Only add `flock` if the test actually fails — do not add it speculatively.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/emit_event.sh scripts/lib/__tests__/emit_event.bats
git commit -m "feat(scripts): add emit_event Bash helper for structured events"
```

---

## Task 2: Source the helper from `ai-run-issue-v2`

**Files:**

- Modify: `scripts/ai-run-issue-v2` (around line 53, after `log()` is defined and before `orchestrator_fail`)

- [ ] **Step 1: Locate insertion point**

Run: `grep -n "^log()" scripts/ai-run-issue-v2`
Expected output (approx): `54:log()  { echo "[$(date +%H:%M:%S)] $*" | tee -a "${ISSUES_DIR}/orchestrator.log" >&2; }`

Insertion goes immediately AFTER the `warn()` line (~56) and BEFORE `orchestrator_fail()`.

- [ ] **Step 2: Add the source line**

Edit `scripts/ai-run-issue-v2`. After the `warn()` definition add:

```bash
# Structured event helper — emits JSON lines to $AI_RUN_EVENTS_FILE.
# When AI_RUN_EVENTS_FILE is unset (standalone Bash run), emit_event is a no-op.
# shellcheck source=lib/emit_event.sh
source "${REPO_ROOT}/scripts/lib/emit_event.sh"
```

- [ ] **Step 3: Verify the script still parses and runs**

Run:

```bash
bash -n scripts/ai-run-issue-v2 && echo "syntax OK"
```

Expected: `syntax OK`

Run (no events file set, function must no-op cleanly):

```bash
(
  source scripts/lib/emit_event.sh
  emit_event "p" "info" "t" "no-op test"
  echo "exit=$?"
)
```

Expected: `exit=0` and no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/ai-run-issue-v2
git commit -m "chore(scripts): source emit_event helper in ai-run-issue-v2"
```

---

## Task 3: Source the helper from `ai-pr-review-poll`

**Files:**

- Modify: `scripts/ai-pr-review-poll` (after the `warn()` definition near line 43)

- [ ] **Step 1: Locate insertion point**

Run: `grep -n "^warn()" scripts/ai-pr-review-poll`

Insertion goes on the line immediately after the `warn()` definition.

- [ ] **Step 2: Add the source line**

Edit `scripts/ai-pr-review-poll`. After `warn()`:

```bash
# shellcheck source=lib/emit_event.sh
source "${REPO_ROOT}/scripts/lib/emit_event.sh"
```

- [ ] **Step 3: Verify it parses**

Run: `bash -n scripts/ai-pr-review-poll && echo "syntax OK"`
Expected: `syntax OK`

- [ ] **Step 4: Commit**

```bash
git add scripts/ai-pr-review-poll
git commit -m "chore(scripts): source emit_event helper in ai-pr-review-poll"
```

---

## Task 4: Add `test:bash` package script and wire into root test command

**Files:**

- Modify: `package.json` (root)

- [ ] **Step 1: Inspect existing scripts**

Run: `jq '.scripts' package.json`

- [ ] **Step 2: Add the bash test script**

Edit `package.json` to add inside `"scripts"`:

```json
"test:bash": "bats scripts/lib/__tests__"
```

If a root `"test"` script exists, change it so it also runs `test:bash` (e.g. `"test": "pnpm -r test && pnpm test:bash"`). If no root `test` exists, leave that alone.

- [ ] **Step 3: Verify**

Run: `pnpm test:bash`
Expected: same 7 passing tests as Task 1.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore: add test:bash script for shell helper tests"
```

---

## Self-Review Notes

- Spec coverage: M2-01 requires (a) helper with strict JSON escaping, (b) sourced from both legacy scripts, (c) tests round-tripped through `jq`. All covered.
- The plan deliberately does NOT add any `emit_event` calls inside the legacy scripts — that work is M2-02 / M2-03.
- The helper is a no-op when `AI_RUN_EVENTS_FILE` is unset so existing Bash-only callers continue to work.
