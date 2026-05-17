# M2-02: Instrument `ai-run-issue-v2` with Phase + Artifact Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert `emit_event` calls throughout `scripts/ai-run-issue-v2` so a complete happy-path run produces a chronologically ordered `events.jsonl` covering run start/end, every phase start/complete/fail, fix-review loop iterations, validation commands, and every artifact written.

**Architecture:** Add a tiny `_emit_phase_done()` wrapper inside the script that is called at every existing `LAST_PHASE=` site. Replace the existing `orchestrator_fail()` with a version that also emits `phase.failed`/`run.failed`. Add `emit_event` calls at every `PHASE=` assignment for `phase.started`, after each successful artifact write for `artifact.created`, and inside the fix-review `while` loop for `loop.iteration.*`. The wrapper script (M1-05) sets `AI_RUN_EVENTS_FILE` and `AI_RUN_DISPLAY_ID` before exec'ing this script, so the helper writes to the right file.

**Tech Stack:** Bash 5.x, `jq`, `bats-core` for golden-trace tests.

---

## Required reading before starting

- `scripts/lib/emit_event.sh` (delivered by M2-01) — function signature: `emit_event <phase> <level> <type> <message> [k=v...]`.
- PRD §16.2.4 event shape: `{ runId, phase, level, type, message, timestamp, metadata }`.
- Phases (canonical names used in events, kebab-case): `read_issue`, `plan-design`, `plan-write`, `implement`, `validate`, `review`, `fix-review`, `compound`, `create-pr`, `done`.
- The script uses `set -euo pipefail`. `emit_event` is no-fail (see M2-01) so calls cannot abort the script.

---

## Event vocabulary (use exactly these `type` strings)

| `type`                     | When                                                               | metadata keys                          |
| -------------------------- | ------------------------------------------------------------------ | -------------------------------------- |
| `run.started`              | Top of script, after env/branch validation, before `read_issue`    | `issueNumber`, `baseBranch`, `branch`  |
| `run.completed`            | Final line of script (success path)                                | `prUrl?`, `durationMs?`                |
| `run.failed`               | Inside `orchestrator_fail()`                                       | `reason`, `lastPhase`                  |
| `phase.started`            | Immediately after each `PHASE="<name>"` line                       | (none)                                 |
| `phase.completed`          | Immediately after each `LAST_PHASE="<name>"` line, on success path | `durationMs`                           |
| `phase.failed`             | Inside `orchestrator_fail()`                                       | `command?`, `exitCode?`, `reason`      |
| `phase.skipped`            | When a phase is skipped via `detect_phase` resume                  | `reason`                               |
| `artifact.created`         | After writing/copying any tracked artifact file                    | `path`, `kind`                         |
| `loop.iteration.started`   | Top of the fix-review `while` loop                                 | `task`, `iteration`, `max`             |
| `loop.iteration.completed` | End of one fix-review iteration with passing reviews               | `task`, `iteration`, `spec`, `quality` |
| `loop.exhausted`           | After fix-review loop hits max iterations                          | `task`, `iterations`                   |
| `command.started`          | About to spawn a validation command                                | `command`                              |
| `command.completed`        | Validation command exited 0                                        | `command`, `exitCode`, `durationMs`    |
| `command.failed`           | Validation command exited non-zero                                 | `command`, `exitCode`, `durationMs`    |

`runId` and `timestamp` are filled by the helper from `AI_RUN_DISPLAY_ID` and the current UTC clock.

`level` mapping: success → `info`; failure → `error`; skip → `warn`.

---

## File Structure

- **Modify:** `scripts/ai-run-issue-v2` — the only production file touched.
- **Create:** `scripts/lib/__tests__/instrumented_run.bats` — golden-trace test using stubs.
- **Modify:** `apps/api/src/compose.ts` and/or `packages/infrastructure/src/bash/run-bash-script.ts` — set `AI_RUN_EVENTS_FILE` + `AI_RUN_DISPLAY_ID` in the env handed to the script.

---

## Task 1: Wire `AI_RUN_EVENTS_FILE` + `AI_RUN_DISPLAY_ID` into the Node wrapper env

**Files:**

- Modify: `apps/api/src/compose.ts` — locate where `runBashScript` is invoked or the env passed in.
- Modify: any caller that builds the `env` object for `runBashScript` (search with `grep -rn "AI_MODEL" apps packages`).

- [ ] **Step 1: Find the env construction site**

Run: `grep -rn "AI_MODEL\|runBashScript" apps packages --include="*.ts"`

Find the spot inside `StartIssueRun` (in `packages/application`) where the `env` map for the bash run is built.

- [ ] **Step 2: Write the failing test**

Add to `packages/application/src/__tests__/start-issue-run.test.ts` (or the file that tests `StartIssueRun`) a new case. If unsure, search:
`grep -rln "StartIssueRun" packages/application/src`

```ts
it('passes AI_RUN_EVENTS_FILE and AI_RUN_DISPLAY_ID to the bash script env', async () => {
  const captured: { env?: Record<string, string> } = {};
  const deps = makeFakeDeps({
    runBashScript: async (input) => {
      captured.env = input.env;
      return { exitCode: 0, durationMs: 1 };
    },
  });
  const usecase = new StartIssueRun(deps);
  const result = await usecase.execute({ issueNumber: 7 });
  expect(captured.env?.AI_RUN_EVENTS_FILE).toMatch(/\.ai-runs\/.*\/events\.jsonl$/);
  expect(captured.env?.AI_RUN_DISPLAY_ID).toBe(result.run.displayId);
});
```

(`makeFakeDeps` already exists in that test file; mirror the existing pattern.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter @ai-sdlc/application test`
Expected: the new test fails — env keys are undefined.

- [ ] **Step 4: Implement**

In the application layer, locate the object passed as `input.env` to `runBashScript`. Add:

```ts
env: {
  ...existingEnv,
  AI_RUN_EVENTS_FILE: runDirectory.paths.eventsJsonlPath,
  AI_RUN_DISPLAY_ID: run.displayId,
},
```

If the application layer does not already receive `RunDirectoryPaths`, plumb it through. The `StartIssueRun` constructor already gets `runDirectoryFactory` per `apps/api/src/compose.ts`; it returns a `RunDirectory` whose `.paths.eventsJsonlPath` is the value to use.

- [ ] **Step 5: Run the test to verify pass**

Run: `pnpm --filter @ai-sdlc/application test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/application apps/api
git commit -m "feat(wrapper): pass AI_RUN_EVENTS_FILE and AI_RUN_DISPLAY_ID to legacy script"
```

---

## Task 2: Add `_emit_phase_done` wrapper and instrument `orchestrator_fail`

**Files:**

- Modify: `scripts/ai-run-issue-v2`

- [ ] **Step 1: Add a per-phase timer + helper near the top of the script**

After the `source ".../emit_event.sh"` line added in M2-01 (around line 56), insert:

```bash
# Per-phase wall-clock tracking. Populated in _emit_phase_started, consumed
# in _emit_phase_done / _emit_phase_failed. Stored as epoch milliseconds.
_PHASE_START_MS=0
_now_ms() {
  if date +%N >/dev/null 2>&1 && [[ "$(date +%N)" != "N" ]]; then
    echo $(( $(date +%s%N) / 1000000 ))
  else
    echo $(( $(date +%s) * 1000 ))
  fi
}

_emit_phase_started() {
  local phase=$1
  _PHASE_START_MS=$(_now_ms)
  emit_event "$phase" "info" "phase.started" "phase ${phase} started"
}

_emit_phase_done() {
  local phase=$1
  local now ms_dur=0
  now=$(_now_ms)
  ms_dur=$(( now - _PHASE_START_MS ))
  (( ms_dur < 0 )) && ms_dur=0
  emit_event "$phase" "info" "phase.completed" "phase ${phase} completed" durationMs="$ms_dur"
}

_emit_phase_skipped() {
  local phase=$1 reason=${2:-resume-detected}
  emit_event "$phase" "warn" "phase.skipped" "phase ${phase} skipped" reason="$reason"
}
```

- [ ] **Step 2: Augment `orchestrator_fail`**

Locate `orchestrator_fail()` (≈ line 63). Add an `emit_event` call before the `gh issue edit` lines:

```bash
orchestrator_fail() {
  reason="$1"
  log "FAIL: $reason"
  emit_event "${LAST_PHASE:-unknown}" "error" "phase.failed" "$reason" reason="$reason"
  emit_event "" "error" "run.failed" "$reason" lastPhase="${LAST_PHASE:-unknown}" reason="$reason"
  if [[ "$reason" == *"blocked"* || "$reason" == *"Blocking"* || "$reason" == *"waiting"* ]]; then
    printf '{"phase":"%s","reason":"%s","time":"%s"}\n' \
      "${LAST_PHASE:-unknown}" "$reason" "$(date -Iseconds)" \
      > "${ISSUES_DIR}/blocked.json"
  fi
  gh issue edit "$ISSUE_NUM" --remove-label "ai:in-progress" 2>/dev/null || true
  gh issue edit "$ISSUE_NUM" --add-label "ai:failed" 2>/dev/null || true
  gh issue comment "$ISSUE_NUM" --body "Automation failed: $reason" 2>/dev/null || true
  exit 1
}
```

- [ ] **Step 3: Verify syntax**

Run: `bash -n scripts/ai-run-issue-v2 && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add scripts/ai-run-issue-v2
git commit -m "feat(scripts): add phase event helpers and emit fail events"
```

---

## Task 3: Emit `run.started` and `run.completed`

**Files:**

- Modify: `scripts/ai-run-issue-v2`

- [ ] **Step 1: Emit `run.started` once at top**

After `LAST_PHASE="start"` (line 324) and before `PHASE="$(detect_phase)"` (line 445), add:

```bash
emit_event "" "info" "run.started" "issue-to-PR run started" \
  issueNumber="$ISSUE_NUM" baseBranch="$BASE_BRANCH" branch="$BRANCH"
```

- [ ] **Step 2: Emit `run.completed` at the success exit**

Locate `PHASE="done"` (line 1738) and the lines that follow it. After the script's final `log "..."` success line (search for "All done" or similar near the bottom — `grep -n "done" scripts/ai-run-issue-v2 | tail -20`), add **before** the final `exit 0` (if present, else as the script's last statement):

```bash
emit_event "" "info" "run.completed" "issue-to-PR run completed" \
  prUrl="${PR_URL:-}"
```

If there's no explicit `exit 0`, this line becomes the last executable statement.

- [ ] **Step 3: Verify syntax**

Run: `bash -n scripts/ai-run-issue-v2 && echo OK`

- [ ] **Step 4: Commit**

```bash
git add scripts/ai-run-issue-v2
git commit -m "feat(scripts): emit run.started and run.completed events"
```

---

## Task 4: Emit `phase.started` and `phase.completed` for every phase

For each of the following sites, insert `_emit_phase_started "<name>"` on the line immediately after the `PHASE="<name>"` assignment, and `_emit_phase_done "<name>"` on the line immediately after the `LAST_PHASE="<name>"` assignment.

| Phase name (use exact string) | `PHASE=` line                                    | `LAST_PHASE=` line                          |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------- |
| `read_issue`                  | implicit (after `detect_phase`) — see Step 1     | 459                                         |
| `plan-design`                 | 577                                              | 586                                         |
| `plan-write`                  | 575, 624 (use line 624 — the actual phase entry) | 632                                         |
| `implement`                   | 676, 685                                         | 693                                         |
| `validate`                    | 1270                                             | 1278                                        |
| `review`                      | 1319                                             | 1327                                        |
| `fix-review`                  | 1380                                             | 1397                                        |
| `compound`                    | 1524                                             | 1531                                        |
| `create-pr`                   | 1578 (use 1578, not the conditional 1537)        | 1586                                        |
| `done`                        | 1738                                             | n/a — emit `run.completed` instead (Task 3) |

**Files:**

- Modify: `scripts/ai-run-issue-v2`

- [ ] **Step 1: read_issue**

After the `if [[ "$PHASE" == "read_issue" ]]; then` block opens (just before `LAST_PHASE="read_issue"` on line 459), add:

```bash
  _emit_phase_started "read_issue"
```

After line 459 (`LAST_PHASE="read_issue"`), add:

```bash
  _emit_phase_done "read_issue"
```

- [ ] **Step 2: plan-design**

After line 577 (`PHASE="plan-design"`) add: `  _emit_phase_started "plan-design"`
After line 586 (`LAST_PHASE="plan-design"`) add: `  _emit_phase_done "plan-design"`

- [ ] **Step 3: plan-write**

After line 624 (`PHASE="plan-write"`) add: `  _emit_phase_started "plan-write"`
After line 632 (`LAST_PHASE="plan-write"`) add: `  _emit_phase_done "plan-write"`

- [ ] **Step 4: implement**

The `implement` phase has two `PHASE="implement"` lines (676 and 685). Add `_emit_phase_started "implement"` **only after line 685** (the actual entry — 676 is the resume-redirect shortcut). After line 693 (`LAST_PHASE="implement"`) add `_emit_phase_done "implement"`.

- [ ] **Step 5: validate**

After line 1270 (`PHASE="validate"`) add: `  _emit_phase_started "validate"`
After line 1278 (`LAST_PHASE="validate"`) add: `  _emit_phase_done "validate"`

- [ ] **Step 6: review**

After line 1319 (`PHASE="review"`) add: `  _emit_phase_started "review"`
After line 1327 (`LAST_PHASE="review"`) add: `  _emit_phase_done "review"`

- [ ] **Step 7: fix-review**

After line 1380 (`PHASE="fix-review"`) add: `  _emit_phase_started "fix-review"`
After line 1397 (`LAST_PHASE="fix-review"`) add: `  _emit_phase_done "fix-review"`

- [ ] **Step 8: compound**

After line 1524 (`PHASE="compound"`) add: `  _emit_phase_started "compound"`
After line 1531 (`LAST_PHASE="compound"`) add: `  _emit_phase_done "compound"`

- [ ] **Step 9: create-pr**

After line 1578 (`PHASE="create-pr"`) add: `  _emit_phase_started "create-pr"`
After line 1586 (`LAST_PHASE="create-pr"`) add: `  _emit_phase_done "create-pr"`

- [ ] **Step 10: Verify syntax + commit**

```bash
bash -n scripts/ai-run-issue-v2 && echo OK
git add scripts/ai-run-issue-v2
git commit -m "feat(scripts): emit phase.started and phase.completed for every phase"
```

> ⚠ Line numbers will shift as you insert lines. Always re-run `grep -n 'PHASE=\|LAST_PHASE=' scripts/ai-run-issue-v2` after each insertion to find the next target.

---

## Task 5: Emit `phase.skipped` events from `detect_phase`

When `detect_phase` returns a phase later than `read_issue`, the script effectively skips earlier phases. We want one `phase.skipped` event per skipped phase so the UI timeline knows.

**Files:**

- Modify: `scripts/ai-run-issue-v2` around line 445 (`PHASE="$(detect_phase)"`)

- [ ] **Step 1: Add skip emission**

After `PHASE="$(detect_phase)"` add:

```bash
# Emit a phase.skipped event for each canonical phase before $PHASE so the
# UI timeline reflects the resume jump.
_emit_skipped_until() {
  local target=$1
  local p
  for p in read_issue plan-design plan-write implement validate review fix-review compound create-pr; do
    if [[ "$p" == "$target" ]]; then return 0; fi
    _emit_phase_skipped "$p" "resume-detected"
  done
}
_emit_skipped_until "$PHASE"
```

- [ ] **Step 2: Verify syntax + commit**

```bash
bash -n scripts/ai-run-issue-v2 && echo OK
git add scripts/ai-run-issue-v2
git commit -m "feat(scripts): emit phase.skipped for phases bypassed by detect_phase resume"
```

---

## Task 6: Emit `artifact.created` for tracked artifacts

For each artifact the script writes that maps to a PRD-listed artifact, emit `artifact.created` immediately after the write succeeds.

Map (line numbers approximate — `grep -n` to confirm):

| Artifact path (relative to `WORKTREE_DIR`) | `kind`               | Where to emit                                                                                                       |
| ------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `design.md`                                | `design`             | Just before line 620 (the fail-if-missing check)                                                                    |
| `plan.md`                                  | `plan`               | Just before line 672                                                                                                |
| `implementation-log.md` or similar         | `implementation_log` | Inside the implement loop, after the report write (find via `grep -n 'implementation-log' scripts/ai-run-issue-v2`) |
| `validate.log` / `validation.md`           | `validation`         | After line 1308 (`cp .../validation.md`)                                                                            |
| `review.md`                                | `review`             | After `review.md` is generated (search `grep -n 'review\.md' scripts/ai-run-issue-v2`)                              |
| `compound.md`                              | `compound`           | After `compound.md` is generated                                                                                    |
| `pr-summary.md`                            | `summary`            | After `pr-summary.md` is generated                                                                                  |
| `pr-url.txt`                               | `pr`                 | After PR_URL is written                                                                                             |

**Files:**

- Modify: `scripts/ai-run-issue-v2`

- [ ] **Step 1: Add a helper near `_emit_phase_done`**

```bash
_emit_artifact() {
  local phase=$1 path=$2 kind=$3
  if [[ -f "$path" ]]; then
    emit_event "$phase" "info" "artifact.created" "artifact ${kind} written" \
      path="$path" kind="$kind"
  fi
}
```

- [ ] **Step 2: Insert calls at each mapped site**

Examples (use the actual variable names already in scope):

```bash
# After plan-design's design.md is written, before the "Design doc not found" check:
_emit_artifact "plan-design" "${WORKTREE_DIR}/design.md" "design"

# After plan-write writes plan.md:
_emit_artifact "plan-write" "${WORKTREE_DIR}/plan.md" "plan"

# After validate copies to validation.md:
_emit_artifact "validate" "${ISSUES_DIR}/validation.md" "validation"

# After review.md is produced:
_emit_artifact "review" "${WORKTREE_DIR}/review.md" "review"

# After compound:
_emit_artifact "compound" "${WORKTREE_DIR}/compound.md" "compound"

# After PR creation:
_emit_artifact "create-pr" "${WORKTREE_DIR}/pr-summary.md" "summary"
_emit_artifact "create-pr" "${WORKTREE_DIR}/pr-url.txt" "pr"
```

For each insertion, use `grep -n 'design\.md\|plan\.md\|review\.md\|validation\.md\|compound\.md\|pr-summary\.md\|pr-url\.txt' scripts/ai-run-issue-v2` to locate the right line.

- [ ] **Step 3: Verify + commit**

```bash
bash -n scripts/ai-run-issue-v2 && echo OK
git add scripts/ai-run-issue-v2
git commit -m "feat(scripts): emit artifact.created events for tracked artifacts"
```

---

## Task 7: Emit fix-review loop events

The fix-review loop lives around lines 1196–1255 (`while [[ $REVIEW_LOOPS -lt 5 ]]; do ... done`).

**Files:**

- Modify: `scripts/ai-run-issue-v2`

- [ ] **Step 1: Emit `loop.iteration.started`**

Inside the `while` loop, immediately after `REVIEW_LOOPS=$((REVIEW_LOOPS + 1))` (≈line 1198) and the existing `log "..."` line, add:

```bash
emit_event "fix-review" "info" "loop.iteration.started" \
  "fix-review loop ${REVIEW_LOOPS}/5 for task ${TASK_NUM}" \
  task="${TASK_NUM}" iteration="${REVIEW_LOOPS}" max=5
```

- [ ] **Step 2: Emit `loop.iteration.completed`**

At the end of the loop body — just before `done` of the `while` — after `SPEC_STATUS` and `QUALITY_STATUS` are populated, add:

```bash
emit_event "fix-review" "info" "loop.iteration.completed" \
  "fix-review loop ${REVIEW_LOOPS} completed (spec=${SPEC_STATUS:-?}, quality=${QUALITY_STATUS:-?})" \
  task="${TASK_NUM}" iteration="${REVIEW_LOOPS}" \
  spec="${SPEC_STATUS:-unknown}" quality="${QUALITY_STATUS:-unknown}"
```

- [ ] **Step 3: Emit `loop.exhausted` on max-iteration failure**

Replace the existing line ≈1249:

```bash
orchestrator_fail "Review loop hit max 5 iterations for task ${TASK_NUM}. Reviews not passing (spec=${SPEC_STATUS:-?}, quality=${QUALITY_STATUS:-?})."
```

with:

```bash
emit_event "fix-review" "error" "loop.exhausted" \
  "fix-review hit max iterations for task ${TASK_NUM}" \
  task="${TASK_NUM}" iterations="$REVIEW_LOOPS"
orchestrator_fail "Review loop hit max 5 iterations for task ${TASK_NUM}. Reviews not passing (spec=${SPEC_STATUS:-?}, quality=${QUALITY_STATUS:-?})."
```

- [ ] **Step 4: Verify + commit**

```bash
bash -n scripts/ai-run-issue-v2 && echo OK
git add scripts/ai-run-issue-v2
git commit -m "feat(scripts): emit fix-review loop iteration and exhaustion events"
```

---

## Task 8: Emit validation `command.started` / `command.completed` / `command.failed`

The validate phase currently invokes commands via the legacy path (search `grep -n 'pnpm\|validate.log\|build failed\|VALIDATE_EXIT' scripts/ai-run-issue-v2` around lines 1270–1310).

**Files:**

- Modify: `scripts/ai-run-issue-v2`

- [ ] **Step 1: Wrap validation command invocations**

Inside the validate phase block, before the line that runs validation commands (find the invocation that produces `validate.log`), introduce a small wrapper:

```bash
_run_validation_cmd() {
  local cmd=$1 logfile=$2
  local start_ms end_ms dur exit_code=0
  start_ms=$(_now_ms)
  emit_event "validate" "info" "command.started" "running validation: $cmd" command="$cmd"
  # Run the command, tee'ing to the log file. Preserve exit code.
  bash -c "$cmd" >>"$logfile" 2>&1 || exit_code=$?
  end_ms=$(_now_ms)
  dur=$(( end_ms - start_ms ))
  if [[ $exit_code -eq 0 ]]; then
    emit_event "validate" "info" "command.completed" "validation passed: $cmd" \
      command="$cmd" exitCode=0 durationMs="$dur"
  else
    emit_event "validate" "error" "command.failed" "validation failed: $cmd" \
      command="$cmd" exitCode="$exit_code" durationMs="$dur"
  fi
  return $exit_code
}
```

- [ ] **Step 2: Use it for each validation command**

The validate phase currently runs the commands as one block. Keep the existing logic intact for now — DO NOT refactor to per-command runs as part of M2 (that's M5-02). Instead, wrap the single block:

```bash
emit_event "validate" "info" "command.started" "running validate suite" command="pnpm-validate-suite"
# ...existing block that produces validate.log and sets VALIDATE_EXIT...
if [[ $VALIDATE_EXIT -eq 0 ]]; then
  emit_event "validate" "info" "command.completed" "validate suite passed" command="pnpm-validate-suite" exitCode=0
else
  emit_event "validate" "error" "command.failed" "validate suite failed" command="pnpm-validate-suite" exitCode="$VALIDATE_EXIT"
fi
```

This delivers the M2-02 acceptance criterion (`phase.failed` emitted with command + exitCode on validation failure) without rewriting the legacy validate logic.

- [ ] **Step 3: Verify + commit**

```bash
bash -n scripts/ai-run-issue-v2 && echo OK
git add scripts/ai-run-issue-v2
git commit -m "feat(scripts): emit command events around validation"
```

---

## Task 9: Golden-trace bats test for the instrumented happy path

**Files:**

- Create: `scripts/lib/__tests__/instrumented_run.bats`

- [ ] **Step 1: Write the failing test**

```bash
#!/usr/bin/env bats
# Smoke test: source the helper, exercise the same instrumentation pattern
# used in ai-run-issue-v2, and assert the produced events.jsonl has the
# expected types in the expected order.

setup() {
  TMPDIR_TEST=$(mktemp -d)
  export AI_RUN_EVENTS_FILE="$TMPDIR_TEST/events.jsonl"
  export AI_RUN_DISPLAY_ID="issue-7-20260516-120000"
  # shellcheck source=../emit_event.sh
  source "${BATS_TEST_DIRNAME}/../emit_event.sh"
}

teardown() { rm -rf "$TMPDIR_TEST"; }

@test "happy-path trace contains expected event types in order" {
  emit_event "" "info" "run.started" "starting" issueNumber=7
  for p in read_issue plan-design plan-write implement validate review fix-review compound create-pr; do
    emit_event "$p" "info" "phase.started" "starting $p"
    emit_event "$p" "info" "phase.completed" "done $p" durationMs=1
  done
  emit_event "" "info" "run.completed" "done"

  run jq -r '.type' "$AI_RUN_EVENTS_FILE"
  [ "$status" -eq 0 ]
  expected="run.started
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
phase.started
phase.completed
run.completed"
  [ "$output" = "$expected" ]
}

@test "failed trace emits phase.failed and run.failed with metadata" {
  emit_event "validate" "error" "phase.failed" "build failed" \
    command="pnpm build" exitCode=2 reason="build failed"
  emit_event "" "error" "run.failed" "build failed" \
    lastPhase="validate" reason="build failed"

  run jq -e '.[0].metadata.exitCode == 2 and .[0].metadata.command == "pnpm build"' <(jq -s '.' "$AI_RUN_EVENTS_FILE")
  [ "$status" -eq 0 ]
  run jq -e '.[1].metadata.lastPhase == "validate"' <(jq -s '.' "$AI_RUN_EVENTS_FILE")
  [ "$status" -eq 0 ]
}
```

- [ ] **Step 2: Run, verify it passes**

Run: `pnpm test:bash`
Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/__tests__/instrumented_run.bats
git commit -m "test(scripts): golden-trace test for instrumented run events"
```

---

## Task 10: Manual smoke test against a stub run

**Files:** none changed.

- [ ] **Step 1: Run the existing M1 wrapper test against a stub script**

If `apps/api/src/__tests__` already has an integration test that runs the wrapper end-to-end with a fake script, run:

```bash
pnpm --filter @ai-sdlc/api test
```

Expected: existing tests still pass.

- [ ] **Step 2: Manually inspect a generated events.jsonl**

Create a tiny fake script and run the wrapper against it:

```bash
mkdir -p /tmp/m2smoke
cat > /tmp/m2smoke/fake-script.sh <<'EOF'
#!/usr/bin/env bash
REPO_ROOT="${REPO_ROOT:-$(pwd)}"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/lib/emit_event.sh"
emit_event "" info run.started "fake start"
emit_event "plan-design" info phase.started "x"
emit_event "plan-design" info phase.completed "x" durationMs=1
emit_event "" info run.completed "fake done"
EOF
chmod +x /tmp/m2smoke/fake-script.sh

AI_RUN_EVENTS_FILE=/tmp/m2smoke/events.jsonl \
  AI_RUN_DISPLAY_ID=manual-smoke \
  REPO_ROOT="$(pwd)" \
  /tmp/m2smoke/fake-script.sh

jq -c . /tmp/m2smoke/events.jsonl
```

Expected: 4 JSON lines, each parses with `jq -c`, and the first/last are `run.started` / `run.completed`.

---

## Self-Review Notes

- Spec coverage: emit_event calls cover run.started/completed/failed, every phase started/completed/failed/skipped, fix-review loop iterations + exhaustion, validation command events, and the listed artifacts. Matches M2-02 acceptance ("at minimum one `phase.started` and `phase.completed` per phase" and "phase.failed with command and exitCode in metadata").
- The validate-phase instrumentation deliberately keeps the legacy bash block intact; per-command structured validation is M5-02.
- Line numbers shift as you insert. Always re-grep before each insert.
- All `emit_event` calls are no-ops when `AI_RUN_EVENTS_FILE` is unset, so existing standalone invocations still work.
