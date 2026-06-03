---
title: Quota-error fast detection via session-log watchdog — breaking opencode's retry loop
date: 2026-05-29
category: orchestrator
module: packages/infrastructure
problem_type: pattern
component: agent-runtime-router
severity: high
symptoms:
  - 8+ minutes wasted per provider quota hit inside opencode's internal retry loop
  - adapter never returned outcome=failed during retries, so router fallback never fired
  - 0-byte agent logs combined with generic "config error or timeout" message
  - orchestration stuck waiting for opencode's retry budget to exhaust itself
root_cause: missing_feature
resolution_type: implementation
tags:
  - quota
  - watchdog
  - session-log
  - opencode-adapter
  - router
  - fallback
  - 429
related_components:
  - packages/infrastructure/src/agent/opencode-adapter.ts
  - packages/infrastructure/src/agent/agent-runtime-router.ts
  - packages/infrastructure/src/agent/quota-patterns.ts
  - packages/shared/src/config/schema.ts
---

# Quota-Error Fast Detection via Session-Log Watchdog

## Problem

When a provider hits its quota cap during agent invocation, opencode swallows the 429 response in its internal retry loop — 8 exponential-backoff retries over ~4 minutes, then ~4 minutes of silence before the 9th retry. The `AbortSignal.timeout` fires at 20 minutes, but by then the only signal is `cancelled_by_orchestrator`, which the router correctly does **not** fall back on (would loop forever).

The router's existing `runtime_error` / `token_limit_exceeded` triggers require `outcome=failed` from the adapter. Since opencode never exits during the retry loop, the adapter never returns, so fallback to a different provider never fires.

A secondary symptom: agent logs are 0 bytes because opencode buffers stdout during retry/wait phases. Combined with the generic diagnostic message ("config error or timeout"), incidents are hard to diagnose from artifacts alone.

## Architecture: Three-Layer Change

| Layer          | Change                                                                          | File                                                        |
| -------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Shared schema  | Add `'quota_exceeded'` to `fallbackTriggerSchema` enum                          | `packages/shared/src/config/schema.ts`                      |
| Quota patterns | Shared regex module used by both adapter and router                             | `packages/infrastructure/src/agent/quota-patterns.ts`       |
| Router         | Import patterns, `isQuotaError()`, switch case, reason mapping, default trigger | `packages/infrastructure/src/agent/agent-runtime-router.ts` |
| Adapter        | Session-log watchdog polling loop, SIGKILL on match                             | `packages/infrastructure/src/agent/opencode-adapter.ts`     |

## Key Design Decisions

### 1. Session-log monitoring over stderr streaming

opencode's stderr is buffered during retries — nothing flushes to the parent process until activity resumes. But opencode **does** write its session log (`~/.local/share/opencode/log/<timestamp>.log`) in real-time, including individual 429 responses. The watchdog polls this file via a `setInterval` loop.

Alternatives considered and rejected:

| Approach                      | Why it doesn't work                                                     |
| ----------------------------- | ----------------------------------------------------------------------- |
| stderr streaming via execa    | Buffered during retries                                                 |
| `--max-retries` opencode flag | Unknown if it exists                                                    |
| Post-exit inspection          | Too late — 429 never triggers exit                                      |
| `fs.watch` over session log   | Platform-specific quirks (inotify coalescing, recursive watch behavior) |

### 2. Watchdog lives in the adapter, not the router

Session-log monitoring is about **detecting** an error in the runtime and surfacing it as `outcome=failed`. The router then **decides** what to do via `shouldFallback()`. This separation keeps concerns clean — the router doesn't know about opencode's log file layout.

### 3. Polling over `fs.watch`

`fs.watch` has platform-specific edge cases (recursive watch behavior, event coalescing on Linux via `inotify`). Polling every 2 seconds with a bounded tail-read is simpler and well within the <10s target. The `quotaPollMs` option (default 2000) is configurable per adapter instance.

### 4. SIGKILL, not SIGTERM

opencode's retry loop may intercept SIGTERM and continue. SIGKILL is immediate and unconditional. `execa` handles SIGKILL on an already-exited process gracefully (no-op).

### 5. `quota_exceeded` in default triggers

Any phase with a `fallbackProfile` but no explicit `fallbackTriggers` automatically falls back on quota errors. This is safe because quota errors are always transient and provider-specific — switching providers is always the correct response.

## Implementation

### Structural log-line filtering (Issue #182)
The watchdog scans opencode session log content for quota/provider error patterns. The session log embeds full tool I/O — agent-written code containing strings like `RESOURCE_EXHAUSTED` or `429` appeared as raw text and triggered false-positive SIGKILLs.
**Fix:** Both `testQuotaPatterns()` and `testProviderErrorPatterns()` now filter to only structural opencode log lines before pattern matching. A structural line matches:
```
/^\s*(INFO|ERROR|WARN|DEBUG)\s+\d{4}-\d{2}-\d{2}T/
```
Lines not matching this prefix (tool output, code content, bash variables) are skipped. This prevents the false-positive scenario where an agent writes code containing quota-pattern strings via its `write`/`edit` tools.
The classifier (`isOpenCodeLogLine`) is exported from `error-patterns.ts` and shared between both pattern-testing functions. It applies to both session log content (watchdog path) and stderr content (exit-handler path).

### `quota-patterns.ts` (shared module)

Both the adapter and router import from this module — patterns are defined once, not duplicated:

```typescript
export const QUOTA_PATTERNS = [
  /Usage limit reached/i,
  /"statusCode":\s*429/,
  /rate_limit_exceeded/i,
  /quota.*exceed/i,
  /\b429\b/,
] as const;

export function testQuotaPatterns(text: string): string | null {
  for (const pattern of QUOTA_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}
```

The `\b429\b` pattern matches `429` as a word-boundary-anchored token to avoid false positives from arbitrary numbers in log content (e.g., line numbers). `testQuotaPatterns` iterates patterns first, then relies on `text.match()` — for very large texts, consider swapping loop order (lines outer, patterns inner) for cache locality.

### Watchdog implementation (opencode-adapter.ts)

The adapter's `invoke()` method spawns opencode via `execa`, then starts a watchdog interval:

```typescript
// In invoke(), after spawning child:
watchdogInterval = this.startWatchdog(child, start);
```

The watchdog (`startWatchdog` private method):

1. **Guards:** Returns `null` if `sessionLogDir` is not configured or doesn't exist.
2. **File selection:** Lists `.log` files in the session log directory, filtering to those with `mtime >= startTimeSec` (only entries written _after_ the invocation began). Scans ALL matching files, not just the newest — prevents wrong-child-log tracking in multi-worker environments.
3. **Offset tracking:** For each file, reads new content since `lastOffset` (tracked per file in a `Map<string, number>`). Offset uses `content.length` (character positions), **not** `Buffer.byteLength` — `.slice()` operates on character indices.
4. **Match:** On the first quota pattern match, stores the matched line and calls `child.kill('SIGKILL')`.
5. **Outcome:** When `child` resolves, if killed by watchdog, outcome is set to `'failed'` and stderr is set to `QUOTA_EXCEEDED: <matched line>`.

```typescript
private startWatchdog(child: execa.ExecaChildProcess, startTimeSec: number): NodeJS.Timeout | null {
  const sessionLogDir = this.options.sessionLogDir;
  if (!sessionLogDir || !existsSync(sessionLogDir)) return null;

  const perFileOffsets = new Map<string, number>();

  return setInterval(() => {
    try {
      const now = Date.now() / 1000;
      const logs = readdirSync(sessionLogDir)
        .filter(f => f.endsWith('.log'))
        .map(f => ({ name: f, stat: statSync(join(sessionLogDir, f)) }))
        .filter(f => f.stat.mtimeMs / 1000 >= startTimeSec)
        .sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);

      for (const log of logs) {
        const content = readFileSync(join(sessionLogDir, log.name), 'utf-8');
        const prevOffset = perFileOffsets.get(log.name) ?? 0;
        const newContent = content.slice(prevOffset);
        perFileOffsets.set(log.name, content.length);

        const match = testQuotaPatterns(newContent);
        if (match) {
          this.onQuota(match);
          child.kill('SIGKILL');
          return;
        }
      }
    } catch {
      // swallow — watchdog is best-effort
    }
  }, this.options.quotaPollMs ?? 2000);
}
```

### Test cleanup pattern

Tests that create temporary stderr/log files must wrap assertions in `try/finally`:

```typescript
let cleanup = true;
try {
  await router.invoke(req());
  // assertions...
} finally {
  if (cleanup) unlinkSync(stderrPath);
}
```

Without `try/finally`, assertion failures before `unlinkSync` create leaked temp files. This was fixed across all quota-related test cases — including pre-existing `token_limit_exceeded` tests.

## Gotchas and Pitfalls

### 1. Offset tracking uses character positions, not byte positions

The watchdog tracks position via `lastOffset`, then reads `content.slice(lastOffset)`. The offset is stored as `content.length` (JavaScript character count), not `Buffer.byteLength(content, 'utf-8')`.

`.slice()` operates on JavaScript character indices (UTF-16 code units). Using byte length would cause a growing discrepancy with multi-byte characters. For ASCII-only log files both work, but using character positions is correct regardless of content.

The review cycled on this twice — always use `content.length` with `.slice()`.

### 2. Instance fields race with concurrent invocations

The plan specified private instance fields (`watchdogKilled`, `watchdogMatch`) on the adapter class, reset at the top of each `invoke()`. This races under concurrent `invoke` calls: two concurrent invocations overwrite each other's state, and reset-at-entry clears an in-flight call's watchdog state.

**Fix:** Use local `let` variables in `invoke()` with a `(match: string) => void` callback (`onQuota`) to communicate match results. The callback pattern also eliminates explicit reset, since each `invoke` call gets fresh locals.

### 3. Scan-all-files, not newest-file-only

The original implementation selected only the most-recently-modified `.log` file. In multi-worker or manual-opencode scenarios, the watchdog could follow the wrong child's log — another opencode session updating a newer log after this invocation starts could cause the watchdog to kill the wrong child on that session's quota line.

**Fix:** Scan ALL `.log` files with `mtime >= startTime`. Per-file offsets tracked via `Map<string, number>`. The deeper concern about correlating to the correct child process remains unresolved (first quota pattern across any file still kills) — accepted as a single-tenant assumption.

### 4. Watchdog is a `setInterval`, not a one-shot

The interval must be `clearInterval`'d when the child process exits. Cleanup happens in two places:

- After `await child` succeeds (in the `try` block)
- In the `catch` block if `await child` throws

If cleanup is missed, the interval continues polling and may access a resolved `child`, causing errors.

### 5. Race: watchdog SIGKILL vs natural process exit

If opencode exits (for any reason) between a watchdog poll cycle and the SIGKILL call, `child.kill('SIGKILL')` is a no-op. `execa` handles this gracefully — sending a signal to an already-exited process is silently ignored on Linux.

### 6. Session log path instability is silent

If opencode changes its session log directory, the watchdog silently degrades to a no-op (returns `null` from `startWatchdog`). This is intentional — the feature is optional and non-breaking. No warning or error log when the directory doesn't exist. If investigating why quota detection isn't firing, check whether `sessionLogDir` is configured and exists.

### 7. Default `sessionLogDir` changes the security contract

The default `sessionLogDir` (`~/.local/share/opencode/log`) means the watchdog **activates by default** without explicit config. All adapter invocations attempt to read and watch the opencode log directory unless explicitly configured away. This is a behavioral change from opt-in to opt-out.

### 8. `testQuotaPatterns` loop order

The function iterates patterns in the outer loop. With 5 patterns and 1000 lines, worst case is 5000 regex tests. For most log files this is negligible. For very large files or frequent calls, swap loop order (lines outer, patterns inner) for cache locality.

### 9. `testQuotaPatterns` splits the entire text on every call

```typescript
const lines = text.split('\n');
```

For the adapter's per-poll call, this is fine (new content is usually a few lines). For repurposing on very large texts, consider `text.includes()` or a streaming approach.

## What to Know Before Modifying This Code

### Adding a new quota pattern

Add a regex to `QUOTA_PATTERNS` in `quota-patterns.ts`. No other code changes needed — the adapter's watchdog and router's `isQuotaError()` both use `testQuotaPatterns()` from the shared module.

The structural log-line filter (`isOpenCodeLogLine`) applies automatically — new patterns only match inside lines with an opencode log prefix. If you need to test patterns against unstructured text, call the regex directly instead of using `testQuotaPatterns()`.

### Adding a new adapter watchdog

The watchdog pattern is specific to opencode's retry behavior. For other adapters with similar "silent retry" behavior:

1. Accept a `sessionLogDir`-like option in the adapter's options interface
2. Call a `startWatchdog(child, startTime)` method after spawning the child
3. Store the interval reference and clean up in `try`/`catch`
4. Check a killed flag after `await child` to determine outcome

### Changing the watchdog polling interval

The default is 2000ms. Set `quotaPollMs` in `OpenCodeAdapterOptions`. Sub-second polling on a spinning disk with many concurrent invocations could cause measurable I/O.

### Layer constraints

- `quota-patterns.ts` lives in `packages/infrastructure` (shared between adapter and router, both in the same package)
- The router imports `@ai-sdlc/application` ports — valid inward dependency
- The adapter does NOT import from the router — dependency flows inward only
- If you need quota patterns in `packages/application` or `packages/shared`, lift patterns to `packages/shared` or define a port

## Related

- Issue #131 — original bug report
- PR #130 — added `runtime_error` / `token_limit_exceeded` triggers (same architectural pattern)
- `docs/solutions/orchestrator/agent-fallback-triggers-2026-05-23.md` — fallback trigger design
