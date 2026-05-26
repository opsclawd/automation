---
title: Agent adapter writing conventions — timeout ownership, execa patterns, budget enforcement
date: 2026-05-26
category: orchestrator
module: packages/infrastructure
problem_type: pattern
component: agent-adapters
symptoms:
  - New adapter writers unsure where timeout/cancellation logic belongs
  - Test shims survive abort signals because shell process isn't the sleeper
  - Budget enforcement using byte size instead of character count
  - Model name vs profile name confusion in adapter argv
root_cause: undocumented_conventions
resolution_type: pattern
severity: medium
related_components:
  - packages/infrastructure/src/agent/opencode-adapter.ts
  - packages/infrastructure/src/agent/pi-adapter.ts
  - packages/infrastructure/src/agent/agent-runtime-router.ts
  - packages/infrastructure/src/agent/__fixtures__/
tags:
  - adapter
  - agent-port
  - timeout
  - cancellation
  - execa
  - prompt-budget
  - convention
---

# Agent Adapter Writing Conventions

## Rule: The orchestrator owns timeouts, not adapters

Adapters do NOT define their own timeout options (`timeoutMsDefault`). The router already composes profile timeout + request abortSignal via `AbortSignal.any()` and passes the result as `request.abortSignal`. The adapter uses only `request.abortSignal` for `execa`'s `cancelSignal`.

**Why:** Timeout ownership must be centralized. If adapters each compose their own timeout signals, the router cannot distinguish "timed out" from "cancelled by orchestrator" without inspecting adapter internals. With centralized ownership, the router reclassifies `cancelled_by_orchestrator` → `outcome: timeout` when the profile timeout fired but the caller's abortSignal did not.

**Exception:** The OpenCode adapter predates this convention and still has `timeoutMsDefault`. It composes its own `AbortSignal.timeout` merged with `request.abortSignal` via `AbortSignal.any()`. New adapters should follow the Pi adapter pattern (no timeout option, delegate to router).

## execa Usage

### `cancelSignal` not `signal`

execa has two separate options:

- `signal` — kills but the promise rejects with an error
- `cancelSignal` — kills cleanly and sets `r.isCanceled` on the result

Use `cancelSignal`. This allows the try/catch to flow through the normal path without throwing, making outcome detection straightforward.

### Combining signals with `AbortSignal.any()`

When the OpenCode adapter needs its own timeout (legacy pattern):

```typescript
const timeoutSignal = AbortSignal.timeout(timeoutMs);
const cancelSignal = request.abortSignal
  ? AbortSignal.any([timeoutSignal, request.abortSignal])
  : timeoutSignal;
```

The Pi adapter (new pattern) uses only `request.abortSignal` directly:

```typescript
const cancelSignal = request.abortSignal;
```

## Outcome Mapping

### Adapter returns, router reclassifies

Adapters return one of three outcomes:

| Outcome   | When                          | Adapter sets                                                     |
| --------- | ----------------------------- | ---------------------------------------------------------------- |
| `success` | Exit code 0                   | —                                                                |
| `timeout` | N/A (router reclassifies)     | —                                                                |
| `failed`  | Non-zero exit OR cancellation | `contractViolations: ['cancelled_by_orchestrator']` if cancelled |

The Pi adapter **never** returns `outcome: 'timeout'` — it returns `failed` with `cancelled_by_orchestrator`. The router reclassifies to `timeout` when the profile timeout signal fired but the request signal didn't.

The OpenCode adapter's combined-signal logic disambiguates at the adapter level: if `timeoutSignal?.aborted && !request.abortSignal?.aborted`, it returns `timeout` directly. This is the legacy pattern; new adapters should not replicate it.

## Test Shims

### `exec sleep` instead of `sleep`

When creating a slow test shim (process that should be killed mid-execution):

```bash
#!/bin/bash
# WRONG: sleep is a subprocess; kill signal hits the shell parent, not sleep
sleep 30
echo "done"

# CORRECT: exec replaces shell process with sleep; signal hits the sleeper
exec sleep 30
```

Without `exec`, when `execa` sends the cancel signal, the shell parent survives because only the `sleep` child received the signal. With `exec`, the shell _becomes_ the sleeper process and receives signals directly.

Note: any code after `exec sleep` is dead — `exec` replaces the process. Remove unreachable statements.

### Test race condition in cancellation tests

Avoid `setTimeout(() => controller.abort(), 100)` — this races with test teardown. Use:

```typescript
await new Promise((r) => setTimeout(r, 50));
controller.abort();
```

Ensures enough time for the child to start before cancellation.

## Prompt Budget Enforcement

### Character count, not byte count

When enforcing a prompt token budget, use character count from `readFileSync(path, 'utf-8').length`, not byte count from `statSync(path).size`. UTF-8 files with multi-byte codepoints have byte sizes that diverge from character counts. The heuristic `Math.ceil(chars / 4)` assumes characters, so the input must be characters.

Enforcement happens **before spawn** — if the budget is exceeded, return `contract_violation` with `contractViolations: ['prompt_budget_exceeded']` and do not spawn a child process.

### Char/4 heuristic is acceptable for v1

A real tokenizer would add a dependency and complicate the adapter. The char/4 heuristic is intentionally over-counted (fewer false passes). Document this assumption in code comments.

## Model Name vs Profile Name

Use `request.model ?? request.profile` for the `--model` flag. Profile names are arbitrary config labels (e.g., `pi-local`), while model names are actual values the CLI needs (e.g., `qwen-3.6-27b`). The `AgentInvocationRequest.model` field is populated by the router from the resolved profile's `model` property.

This distinction matters: passing a profile name as `--model` causes the CLI to fail with "unknown model."

## `exitCode` on contract violation returns

`AgentInvocationResult.exitCode` is typed as `number`, not `number | undefined`. When returning a contract-violation result where no child was spawned, use `exitCode: 0` as the fallback. A code path that never ran cannot have a meaningful exit code. Do not change to `undefined` without updating the DB schema and router's update path.

## Adding a New Adapter

1. Create adapter in `packages/infrastructure/src/agent/` implementing `AgentPort`
2. Export from `packages/infrastructure/src/agent/index.ts`
3. Wire into `AgentRuntimeRouter`'s `adapters` map in `apps/api/src/compose.ts`
4. Add CLI test shims in `__fixtures__/` (chmod +x)
5. Tests should cover: success, non-zero exit, timeout/cancellation, prompt budget (if applicable)

Follow the Pi adapter pattern: no `timeoutMsDefault`, use only `request.abortSignal`, return `failed` + `cancelled_by_orchestrator` on cancellation, let the router handle reclassification.
