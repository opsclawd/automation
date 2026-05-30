---
title: Antigravity adapter — hang, process leak, and prompt-via-argv fixes
date: 2026-05-30
category: integration-issues
module: packages/infrastructure/src/agent
problem_type: integration_issue
component: antigravity-adapter
severity: high
symptoms:
  - agy child process hangs indefinitely with 0 bytes of output
  - Orphaned agy processes accumulate across runs (alive 1h+)
  - timeout-triggered fallback can't rescue the run (separate issue #150)
  - Large review prompts cause E2BIG from argv overflow
root_cause: multiple
resolution_type: code_fix
tags:
  - antigravity
  - agy
  - forceKillAfterDelay
  - process-group-kill
  - stdin-prompt
  - execa
  - external-cli-runner
---

# Antigravity Adapter — Hang, Process Leak, and Prompt-via-Argv Fixes

## Problem

The `antigravity` runtime adapter (`AntigravityAgentAdapter`) had three interrelated defects that made it unusable and dangerous in production:

1. **`agy --print <prompt>` hangs indefinitely** — `agy` blocks waiting for interactive permission prompts when no TTY is present. In production run `44073024-5c1b-4972-8ef0-84bebb6a7526`, it produced 0 bytes of output over 10 minutes.

2. **Hung `agy` is never force-killed** — `runExternalCli` in `external-cli-runner.ts` relied solely on execa's `cancelSignal`, which sends **SIGTERM** once. `agy` ignores SIGTERM (or detaches), so the child survives cancellation and leaks as an orphan. Multiple leaked PIDs were found in `Sl+` state 1h+ after the run failed, requiring manual `kill -9`.

3. **Prompt passed via argv, not stdin** — The full review prompt (including git diffs) was placed on the command line as `['--print', promptContent]`, risking `E2BIG`/`ARG_MAX` (~2MB on Linux) for large diffs. This diverged from the opencode adapter, which delivers prompts via stdin (see issue #112 for precedent).

A compounding factor: the timeout-triggered fallback mechanism (#150) inherits the expired `AbortSignal`, so when `agy` hangs, the opencode fallback can't rescue the run either — the entire orchestration run dies.

## Files Changed

| File | Change |
|---|---|
| `packages/infrastructure/src/agent/external-cli-runner.ts` | Added `forceKillAfterDelay: 5_000`, `detached: true`, process-group cleanup in `finally` block + `forceKillAfterDelayMs` config option |
| `packages/infrastructure/src/agent/antigravity-adapter.ts` | Changed args to `['--dangerously-skip-permissions', '--print', '-']`, added `input: prompt` for stdin delivery |
| `packages/infrastructure/src/agent/__fixtures__/fake-agy-success.sh` | Updated to consume stdin and report character count |
| `packages/infrastructure/src/agent/__fixtures__/fake-agy-hang.sh` | **New** — ignores SIGTERM, sleeps 300s, for force-kill test |
| `packages/infrastructure/src/agent/__fixtures__/fake-agy-args-logger.sh` | **New** — captures args and stdin to files, for content-level test assertions |
| `packages/infrastructure/src/agent/__tests__/antigravity-adapter.test.ts` | Rewrote prompt-via-argv test to prompt-via-stdin, added `--dangerously-skip-permissions` test, added force-kill test, fixture output uses per-test tmpdirs |

## Decisions and Trade-offs

### Decision 1: Fix in shared `runExternalCli` (Approach A), not just the adapter

The process-leak fix could have gone in the adapter alone (bypassing `runExternalCli` like `OpenCodeAgentAdapter` does). We chose to fix the shared runner for three reasons:

- **Fixes the bug class universally** — any future adapter using `runExternalCli` gets guaranteed child termination for free.
- **Keeps adapters thin** — the antigravity adapter stays a thin delegation layer. Duplicating execa boilerplate (artifact dir creation, stdout/stderr logging, git SHA capture) across adapters increases maintenance burden.
- **Consistent with existing architecture** — the antigravity adapter already delegates to `runExternalCli`. Fixing the runner is the minimal-change path.

**Trade-off:** `forceKillAfterDelay` and `detached: true` now apply to all `runExternalCli` callers. This is safe because SIGKILL escalation after a grace period is universally beneficial — a process that has already exited won't be affected, and a process that exits during the grace period will be caught by the SIGKILL safety net. If a future caller needs different behavior, `forceKillAfterDelayMs` is configurable via `ExternalCliRunInput`.

### Decision 2: `detached: true` + process-group `kill(-pid)` as safety net

Two layers of cleanup:

1. **execa's `forceKillAfterDelay: 5_000`** — sends SIGTERM on cancel, escalates to SIGKILL after 5s if the child hasn't exited. Handles the main process.

2. **`process.kill(-child.pid, 'SIGKILL')` in `finally`** — kills the entire process group. Handles sub-processes that `agy` may have spawned.

The `finally` block is the safety net: even if something unexpected happens (execa bug, promise rejection path), no process group survives. The `try/catch` handles `ESRCH` (process already exited).

**Important nuance:** The `finally` block runs on *every* invocation, including success. Early review feedback flagged this as potentially aggressive (theoretical PID reuse race). The guard `if (outcome !== 'success')` was added to limit it to failed/timeout/cancelled paths only. On the success path, the child has already exited cleanly, so the kill is a no-op (ESRCH caught).

### Decision 3: 5-second grace period between SIGTERM and SIGKILL

`forceKillAfterDelay: 5_000` gives well-behaved processes time to flush buffers and clean up after SIGTERM while preventing resource waste. The 5s default was chosen because:

- The primary concern is preventing orphan accumulation (minutes to hours), not optimizing sub-second termination
- Short enough that hung processes don't waste resources
- Long enough for normal cleanup (writing stdout/stderr, closing file handles)
- Configurable per-caller via `ExternalCliRunInput.forceKillAfterDelayMs`

### Decision 4: `--dangerously-skip-permissions` and `--print -` (unverifiable in CI)

The adapter now passes `['--dangerously-skip-permissions', '--print', '-']` and pipes the prompt via `input`. These flags were identified in issue comment investigation but **cannot be verified against the real `agy` binary in CI** — tests use fake shims that accept any arguments.

**Risk mitigation:** Even if these flags are wrong and `agy` still hangs in production, the force-kill fix prevents orphaned processes. The run will still fail (timeout out) but won't leak processes.

The `--print -` convention (read from stdin via `-`) follows standard CLI patterns. The opencode adapter uses the same stdin-delivery approach. If `agy --print -` doesn't work in production, an alternative is a temp-file approach (`--print-file <path>`).

### Decision 5: Configurable output directory via `AGY_LOG_DIR` in args-logger fixture

Review feedback identified that the original fixture wrote output files to the shared `__fixtures__` directory, creating a race condition if tests ever ran in parallel. The fix: the fixture reads `AGY_LOG_DIR` from the environment, falling back to `$(dirname "$0")`. Tests pass a per-test `mkdtempSync` temp directory via the env var, ensuring parallel safety.

## Key Implementation Details

### `external-cli-runner.ts` — the force-kill + process-group cleanup

The `runExternalCli` function now spawns the child process with `detached: true` and `forceKillAfterDelay`:

```typescript
const child = execa(input.bin, input.args, {
  cwd: input.cwd,
  reject: false,
  all: false,
  detached: true,
  ...(input.input !== undefined ? { input: input.input } : {}),
  ...(cancelSignal ? { cancelSignal } : {}),
  forceKillAfterDelay: input.forceKillAfterDelayMs ?? 5_000,
});
try {
  const r = await child;
  // ... process result (stdout, stderr, exitCode, isCanceled) ...
} catch (e) {
  outcome = 'failed';
  exitCode = 1;
  stderr = String((e as Error).message);
} finally {
  if (outcome !== 'success') {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // ESRCH = process already dead, ignore
    }
  }
}
```

Key behaviors:
- `detached: true` puts the child in its own process group, allowing `kill(-pid)` to target the entire group
- `forceKillAfterDelay: 5_000` escalates SIGTERM → SIGKILL after 5 seconds
- The `finally` block only runs on non-success paths (thanks to review feedback)
- `kill(-child.pid)` targets the process group (negative PID sends signal to the group)
- ESRCH errors are silently swallowed (process already dead = desired state)

### `antigravity-adapter.ts` — stdin delivery + headless flags

```typescript
const args = ['--dangerously-skip-permissions', '--print', '-'];
return runExternalCli({
  runtime: 'antigravity',
  bin,
  args,
  input: prompt,        // prompt piped via stdin, not argv
  cwd: request.cwd,
  artifactsDir: this.opts.artifactsDir,
  model: request.model ?? '',
  ...(request.provider !== undefined ? { provider: request.provider } : {}),
  ...(this.opts.timeoutMsDefault !== undefined
    ? { timeoutMsDefault: this.opts.timeoutMsDefault }
    : {}),
  ...(request.abortSignal ? { abortSignal: request.abortSignal } : {}),
});
```

The `input` field is passed through to execa's options, which writes it to the child's stdin pipe synchronously at spawn time. The `ExternalCliRunInput` interface already had `input?: string` — the runner already passed it through.

### Test fixtures

**`fake-agy-hang.sh`** — validates force-kill escalation:
```bash
#!/usr/bin/env bash
trap '' SIGTERM
echo "starting"
exec sleep 300
```

Note: no `set -euo pipefail` (intentional). The `trap '' SIGTERM` causes the shell to ignore SIGTERM, and `exec sleep 300` replaces the shell process with `sleep` while preserving signal disposition (POSIX: `exec` preserves ignored signals). This means the `sleep` process also ignores SIGTERM, forcing the test to validate the SIGKILL escalation path.

**`fake-agy-args-logger.sh`** — validates args and stdin content:
```bash
#!/usr/bin/env bash
set -euo pipefail
output_dir="${AGY_LOG_DIR:-"$(dirname "$0")"}"
echo "$@" > "$output_dir/agy-last-args.txt"
cat > "$output_dir/agy-last-stdin.txt"
echo "fake agy success" >&1
echo "no errors" >&2
exit 0
```

Uses `AGY_LOG_DIR` env var for thread-safe output file location (falls back to fixtures dir for manual testing).

**`fake-agy-success.sh`** — updated to consume stdin:
```bash
#!/usr/bin/env bash
set -euo pipefail
stdin_content=$(cat)
echo "fake agy success: OK (stdin ${#stdin_content} chars)" >&1
echo "no errors" >&2
exit 0
```

The existing success test asserts `toContain('fake agy success')`, which still matches the updated output. This validates that stdin delivery works end-to-end.

### Tests

| Test | What it validates |
|---|---|
| `returns success` | 0-exit child produces `outcome: success`, stdout contains expected text, runtime is `"antigravity"`, endCommitSha is set |
| `returns failed outcome` | Non-zero exit code produces `outcome: failed` |
| `passes the prompt via stdin, not argv` | Prompt content appears in captured stdin but NOT in logged argv (replaces old "passes prompt as --print argument" test) |
| `includes --dangerously-skip-permissions in args` | The flag is present in the logged argv |
| `marks cancellation via AbortController as cancelled_by_orchestrator` | AbortController.abort() produces `failed` outcome with `cancelled_by_orchestrator` contract violation |
| `returns timeout outcome` | Slow process exceeding `timeoutMsDefault` produces `outcome: timeout` |
| `force-kills a SIGTERM-ignoring child within grace period` | SIGTERM-ignoring process is killed within 15s (200ms timeout + 5s grace period + buffer). Asserts `outcome: timeout` and elapsed < 15s |

## Gotchas, Pitfalls, and Lessons Learned

### 1. `exec sleep 300` (not bare `sleep 300`) in hang fixture

The hang fixture uses `trap '' SIGTERM` followed by `exec sleep 300`. The `exec` is critical: without it, the shell forks `sleep` as a subprocess, and only the shell parent receives SIGTERM (which it ignores). With `exec`, the shell process *becomes* `sleep`, and `sleep` inherits the ignored SIGTERM disposition (POSIX requires `exec` to preserve ignored signals). Without `exec`, the test would pass even without the force-kill fix because `sleep` would die on SIGTERM while the shell parent survived.

The fixture also deliberately omits `set -euo pipefail` — `set -e` can interfere with signal disposition, and the fixture needs to be robust to SIGKILL at any point.

### 2. `detached: true` + `input` compatibility in execa 9.x

There was a pre-implementation concern that `detached: true` might interfere with stdin piping (the child gets a new process group, and execa might not write stdin before the child detaches). **This works correctly** because execa writes to the child's stdin pipe synchronously at spawn time, before the child process group change takes effect. All existing stdin tests passed.

### 3. `forceKillAfterDelay` affects outcome path

Before `forceKillAfterDelay`, the cancel signal caused execa to send SIGTERM and `await child` resolved with `isCanceled: true`. With `forceKillAfterDelay`, if SIGTERM is ignored, the process continues running until the grace period expires, then execa sends SIGKILL (which kills the process immediately). The `await child` still resolves with `isCanceled: true`. The timeout test (`fake-agy-slow.sh`, which sleeps 30s) still passes because `sleep` does NOT ignore SIGTERM — it exits on SIGTERM before the grace period expires.

### 4. Fixture output files must be parallel-safe

The original `fake-agy-args-logger.sh` wrote to `$(dirname "$0")/agy-last-*.txt` — the shared fixtures directory. If tests ever run in parallel, concurrent writes race. The fix uses `AGY_LOG_DIR` env var, and tests pass per-test `mkdtempSync` directories. This pattern should be used for any new test fixture that writes files.

### 5. `--dangerously-skip-permissions` is an acknowledged blind spot

The adapter's code comments explicitly note this risk. The flag name was identified in issue comment investigation but has never been verified against the real `agy` binary. If the flag doesn't exist, `agy` will still hang in production — but the force-kill fix prevents orphan accumulation, which was the critical production issue. Consider adding a conditional smoke test (gated by an env var like `AGY_BINARY`) that runs against the real binary in environments where it's available.

### 6. Review feedback: `finally` block ran on every invocation

The original implementation sent `process.kill(-child.pid, 'SIGKILL')` in the `finally` block unconditionally. Code review flagged this as unnecessarily aggressive for the success path — even though the ESRCH catch makes it safe, the pattern is clearer when guarded by `outcome !== 'success'`. The guard was added in the fixup commit following review.

### 7. Review feedback: `forceKillAfterDelay` hardcoded

Originally `forceKillAfterDelay: 5_000` was hardcoded. Review feedback requested configurable grace period. Added `forceKillAfterDelayMs?: number` to `ExternalCliRunInput` with `input.forceKillAfterDelayMs ?? 5_000` as the default.

## Modifying This Code

### Adding a new adapter that uses `runExternalCli`

1. Create the adapter implementing `AgentPort` in `packages/infrastructure/src/agent/`
2. Call `runExternalCli()` with the appropriate `bin`, `args`, and optional `input` (stdin)
3. If the adapter needs a different SIGTERM→SIGKILL grace period, pass `forceKillAfterDelayMs`
4. Add fake fixtures in `__fixtures__/` (chmod +x, use `AGY_LOG_DIR`-style env var for parallel-safe test artifacts)
5. Wire into `AgentRuntimeRouter`'s adapters map in `apps/api/src/compose.ts`

### Changing the force-kill behavior

The grace period is configurable per-invocation via `ExternalCliRunInput.forceKillAfterDelayMs`. To disable the process-group kill in `finally`, remove or guard the `process.kill(-child.pid, 'SIGKILL')` block. Note that `forceKillAfterDelay` is an execa feature — if you remove `detached: true`, the process-group kill via `kill(-pid)` will no longer work (it requires the child to be in its own process group).

### If `agy` still hangs in production

- Verify `--dangerously-skip-permissions` is the correct flag name — update in `antigravity-adapter.ts:23`
- Verify `--print -` reads from stdin — if not, switch to `--print-file <tempfile>` pattern
- Check that auth/credentials are pre-configured in the deployment environment
- The force-kill fix ensures that even if `agy` hangs, no orphan processes accumulate (the process is SIGKILL'd within `timeoutMsDefault + 5000ms`)

### If the stdin delivery breaks

- `detached: true` + `input` compatibility in execa is confirmed working for execa ^9.5.1
- If an execa upgrade breaks this, remove `detached: true` and rely solely on `forceKillAfterDelay` — the main process will still be killed, but sub-processes of `agy` might not be cleaned up

## Related

- Issue #151 — this fix
- Issue #150 — fallback inherits expired `AbortSignal` (compounding issue, separate fix)
- Issue #145 — original Antigravity adapter plan
- Issue #112 — opencode adapter prompt-via-stdin precedent (same pattern)
- `docs/solutions/integration-issues/opencode-adapter-stdin-prompt-2026-05-26.md` — prior stdin fix for opencode
- PR #114 — review history for the opencode stdin fix
- `docs/solutions/orchestrator/agent-adapter-writing-conventions-2026-05-26.md` — adapter conventions (timeout ownership, execa patterns, `exec sleep` pattern)
