---
title: Agent profile fallback triggers — router-enforced and caller-signalled escalation
date: 2026-05-23
category: orchestrator
module: packages/infrastructure
problem_type: feature
component: agent-runtime-router
symptoms:
  - agent invocation failure with no automatic recovery
  - no observable escalation events in SSE stream
  - callers have no way to signal semantic fallback triggers
root_cause: new_feature
resolution_type: implementation
severity: n/a
related_components:
  - packages/infrastructure/src/agent/agent-runtime-router.ts
  - packages/application/src/agent/invocation.ts
  - packages/application/src/agent/contract-violation-codes.ts
  - apps/api/src/compose.ts
tags:
  - fallback
  - escalation
  - router
  - agent-invocation
  - observability
  - contract-violation
---

# Agent Profile Fallback Triggers (M4-02c)

## Problem

When an agent invocation fails at the adapter level (timeout, contract violation), the orchestrator had no automatic recovery path. Operators configure a `fallbackProfile` per phase in `.ai-orchestrator.json` (e.g., Pi → OpenCode), but nothing wired that configuration into actual dispatch behaviour. Additionally, phase/loop use cases needed a protocol to signal semantic escalations (two consecutive failures, file budget overruns, etc.) without the router second-guessing their decision.

## Architecture: Two Fallback Paths

The system splits fallback responsibility per ADR-0007/ADR-0008:

| Owner                   | Triggers                                                                                                                                                                       | How                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Router** (mechanical) | `timeout`, `contract_violation` (any), `runtime_error`, `token_limit_exceeded`, `quota_exceeded`, `prompt_budget_exceeded`, `missing_required_artifact`, `invalid_result_json` | Detected from `AgentInvocationResult` after adapter returns; `runtime_error` fires on any `outcome='failed'`; `token_limit_exceeded`/`quota_exceeded` additionally require stderr pattern matching via `isTokenLimitError()`/`isQuotaError()` |
| **Use case** (semantic) | Two consecutive failures, touched-file budget, validation category change, architectural ambiguity                                                                             | Caller sets `fallbackOfInvocationId` + `fallbackReason` on `AgentInvocationRequest`                                                                                                                                                           |

The router doesn't second-guess use-case decisions. If `fallbackOfInvocationId` is set by the caller, the router records and emits without applying its own trigger heuristics.

### Important: caller-signalled fallback is handled in `invoke()`, not `dispatch()`

When `fallbackOfInvocationId` is set on the **initial request**, the router handles it in `invoke()` **before** calling `dispatch()`. The router emits the escalation event and dispatches directly to the target profile. `shouldFallback()` inside `dispatch()` is never evaluated for caller-signalled requests.

This separation was introduced after a review caught that the original `shouldFallback()` returned `true` whenever `fallbackOfInvocationId` was set, regardless of the adapter outcome. A **successful** caller-signalled invocation was being discarded and a redundant second fallback dispatched. The fix moved caller-signalled handling out of `shouldFallback()` entirely — the router trusts the caller's escalation decision and does not re-evaluate it.

## Key Implementation Decisions

### 1. `invoke()` → `dispatch()` split with `isFallback` flag

**Decision:** Refactor `AgentRuntimeRouter.invoke()` into a public `invoke()` that delegates to private `dispatch(request, isFallback?)`.

**Why:** Originally the plan called for a `callerSignalled` boolean to distinguish router-triggered from caller-signalled fallbacks. The actual implementation uses `isFallback` instead — when `dispatch` is called recursively for a second hop, `isFallback=true` prevents infinite chains. The caller-signalled path is detected from `request.fallbackOfInvocationId` being set on the _initial_ request.

**Gotcha:** A naive recursive call to `this.invoke()` would re-evaluate `fallbackOfInvocationId !== undefined` and misidentify a router-triggered fallback's second invocation as caller-signalled. The `isFallback` parameter on `dispatch()` prevents this.

### 2. One-hop bound — no chained escalation

**Decision:** If the fallback profile also fails, that failure surfaces directly. No third invocation.

**How:** The `isFallback` parameter on `dispatch()` gates the fallback logic. When `isFallback=true`, the entire `shouldFallback()` check is skipped, so even if the fallback's result is a `timeout` or `contract_violation`, no further escalation occurs.

### 3. Event emission before fallback invocation

**Decision:** `phase.fallback.escalated` is emitted _before_ the fallback `dispatch()` call, not after.

**Why:** If the fallback itself fails, the event is still observable. The event includes `{ fromProfile, toProfile, triggerReason, triggerOwner }`.

### 4. `fallbackReason` capped at 64 characters

**Decision:** The router truncates `fallbackReason` with `.slice(0, 64)` as defense-in-depth, even though callers are expected to cap it.

### 5. No new event schema type

**Decision:** `OrchestratorEvent.type` is a freeform `string`. No changes to `packages/shared/src/events/schema.ts` were needed. The router emits `type: 'phase.fallback.escalated'` directly.

### 6. Contract violation codes in application layer, not shared

**Decision:** `contract-violation-codes.ts` lives in `packages/application/src/agent/` rather than `packages/shared/`.

**Why:** Referenced by M4-02b, M4-04, M4-05 which are all in the application layer. Elevating to shared would be unnecessary coupling. The file exports a single `CONTRACT_VIOLATION_CODES` const object with string values.

## File Map

| File                                                                                | What it does                                                                                                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/application/src/agent/invocation.ts`                                      | `AgentInvocationRequest` with `fallbackOfInvocationId?: AgentInvocationId` and `fallbackReason?: string`                                                           |
| `packages/application/src/agent/contract-violation-codes.ts`                        | Shared `CONTRACT_VIOLATION_CODES` const (also references `invalid_result_value`, `missing_commit`, `not_pushed`, `replies_not_posted` added during implementation) |
| `packages/infrastructure/src/agent/agent-runtime-router.ts`                         | `AgentRuntimeRouter` with `invoke()` → `dispatch()` split, `shouldFallback()`, `determineTriggerReason()`, `emitFallbackEvent()`, and `EventBusPort` wiring        |
| `apps/api/src/compose.ts`                                                           | Passes existing `InMemoryEventBus` (line 108) as `eventBus` to router options                                                                                      |
| `packages/infrastructure/src/agent/agent-runtime-router.ts`                         | `isTokenLimitError()`, `isQuotaError()`, extended switch cases in `shouldFallback()` + `determineTriggerReason()`                                                  |
| `packages/infrastructure/src/agent/quota-patterns.ts`                               | Shared `QUOTA_PATTERNS` regex array + `testQuotaPatterns()` used by both adapter and router                                                                        |
| `packages/shared/src/config/schema.ts`                                              | `fallbackTriggerSchema` enum extended with `runtime_error`, `token_limit_exceeded`, `quota_exceeded`                                                               |
| `.ai-orchestrator.json`                                                             | `runtime_error`/`token_limit_exceeded` added to default triggers; `fallbackTriggers` cleaned up to `{ profile, fallbackProfile }` only                             |
| `packages/infrastructure/src/agent/__tests__/router-fallback.test.ts`               | 5 adapter-level trigger variants + bounded-chain test + `runtime_error`/`token_limit_exceeded`/`quota_exceeded` trigger tests                                      |
| `packages/infrastructure/src/agent/__tests__/router-fallback-caller-signal.test.ts` | Caller-signalled fallback + 64-char truncation test                                                                                                                |
| `packages/infrastructure/src/agent/__tests__/router-fallback-none.test.ts`          | No fallbackProfile configured → original failure surfaces                                                                                                          |

## How Fallback Dispatch Works

```
invoke(request)
  ├─ If request.fallbackOfInvocationId is set (caller-signalled):
  │     ├─ Emit phase.fallback.escalated (triggerOwner: 'use_case')
  │     └─ dispatch(request, isFallback=true)  ← skip shouldFallback()
  └─ Else (router-triggered path):
       └─ dispatch(request, isFallback=false)
            ├─ Build pre-insert invocation row
            ├─ If request.fallbackOfInvocationId → set on row
            ├─ Resolve profile → adapter
            ├─ Call adapter.invoke(enrichedRequest)
            ├─ Reclassify cancelled_by_orchestrator → timeout if profile signal
            ├─ Update invocation row with result
            ├─ If NOT isFallback AND shouldFallback(request, result):
            │     ├─ Look up phaseProfiles[phaseId].fallbackProfile
            │     ├─ If fallbackProfile exists and profile+adapter valid:
            │     │     ├─ Determine triggerOwner ('router')
            │     │     ├─ Determine triggerReason (from result)
            │     │     ├─ Cap triggerReason at 64 chars
            │     │     ├─ Build fallbackRequest with fallbackOfInvocationId = id
            │     │     ├─ Emit phase.fallback.escalated event
            │     │     └─ dispatch(fallbackRequest, isFallback=true)  ← ONE HOP ONLY
            │     └─ Else: no fallback available, return failure
            └─ Return result
```

## Config Schema: Configurable Triggers

`packages/shared/src/config/schema.ts` — `fallbackTriggerSchema` is a `z.enum()` with all supported trigger values:

```typescript
const fallbackTriggerSchema = z.enum([
  'timeout',
  'contract_violation',
  'missing_required_artifact',
  'prompt_budget_exceeded',
  'invalid_result_json',
  'runtime_error',
  'token_limit_exceeded',
  'quota_exceeded',
]);
```

New triggers start as opt-in when added. After proving stable, they may be promoted to the default set.

## Trigger Detection Logic

`shouldFallback(request, result)` is a `switch` over each trigger in the phase's `fallbackTriggers` array (defaulting to the system-wide default when unset):

| Trigger                     | When it fires                                                          |
| --------------------------- | ---------------------------------------------------------------------- |
| `timeout`                   | `result.outcome === 'timeout'`                                         |
| `contract_violation`        | `result.outcome === 'contract_violation`' (any code)                   |
| `runtime_error`             | `result.outcome === 'failed'`                                          |
| `token_limit_exceeded`      | `result.outcome === 'failed'` AND `isTokenLimitError(result) === true` |
| `quota_exceeded`            | `result.outcome === 'failed'` AND `isQuotaError(result) === true`      |
| `missing_required_artifact` | (checked via contract violation codes)                                 |
| `prompt_budget_exceeded`    | (checked via contract violation codes)                                 |
| `invalid_result_json`       | (checked via contract violation codes)                                 |

Note: caller-signalled fallback (`fallbackOfInvocationId` set on initial request) is **not** evaluated by `shouldFallback()` — it's handled earlier in `invoke()`.

### Default triggers extension

The default trigger set (used when no phase overrides `fallbackTriggers`) was extended from `['timeout', 'contract_violation']` to include `runtime_error`, `token_limit_exceeded`, and `quota_exceeded`. This is safe because:

- `runtime_error` only fires on `outcome='failed'`, which was always a serious error
- `token_limit_exceeded` requires stderr pattern matching — false positives are rare
- `quota_exceeded` is always transient and provider-specific — switching providers is always correct

Pre-existing configs without `fallbackTriggers` pick up the new defaults automatically. Phases that explicitly set `fallbackTriggers` must opt in to individual triggers.

### `determineTriggerReason(result)` — asymmetry warning

`determineTriggerReason(result)` provides a human-readable reason. It is **asymmetric** with `shouldFallback`: it returns `'runtime_error'` for ALL `outcome='failed'` outcomes, even when the specific trigger that matched was `token_limit_exceeded` or `quota_exceeded`. This is safe because `determineTriggerReason` is only called after `shouldFallback` already returned `true`, so the reason is always consistent with the trigger that matched.

```typescript
switch (result.outcome) {
  case 'timeout':
    return 'timeout';
  case 'contract_violation':
    if (codes.has('prompt_budget_exceeded')) return 'prompt_budget_exceeded';
    if (codes.has('missing_required_artifact')) return 'missing_required_artifact';
    if (codes.has('invalid_result_json')) return 'invalid_result_json';
    return 'contract_violation';
  case 'failed':
    if (isTokenLimitError(result)) return 'token_limit_exceeded';
    if (isQuotaError(result)) return 'quota_exceeded';
    return 'runtime_error';
}
```

For caller-signalled fallbacks, the reason comes from `request.fallbackReason ?? 'unknown'`.

### Stderr pattern matching: `isTokenLimitError()` and `isQuotaError()`

Both functions read the result's `stderrPath` via `readFileSync` and test against known regex patterns. They catch ENOENT and other read errors by returning `false`.

```typescript
// agent-runtime-router.ts
const TOKEN_LIMIT_PATTERNS = [
  /context_length_exceeded/i, // Anthropic-style
  /prompt is too long/i, // OpenAI-style
  /token.*limit.*exceed/i, // generic
  /maximum context length/i, // OpenAI-style
  /request too large/i, // generic provider
];

function isTokenLimitError(result: AgentInvocationResult): boolean {
  try {
    const stderr = readFileSync(result.stderrPath, 'utf-8');
    return TOKEN_LIMIT_PATTERNS.some((p) => p.test(stderr));
  } catch {
    return false;
  }
}
```

Both adapters (opencode and pi) write stderr synchronously (`writeFileSync`) before returning, so stderr is always available when the router reads it.

### `isQuotaError()` uses `testQuotaPatterns()` from a shared module

Unlike `isTokenLimitError`, `isQuotaError` delegates to `testQuotaPatterns()` in `packages/infrastructure/src/agent/quota-patterns.ts`, which is also imported by the opencode adapter's watchdog. The patterns are defined in one place:

```typescript
export const QUOTA_PATTERNS = [
  /Usage limit reached/i,
  /"statusCode":\s*429/,
  /rate_limit_exceeded/i,
  /quota.*exceed/i,
  /\b429\b/,
] as const;
```

`testQuotaPatterns` iterates patterns first, then lines. It returns the matching line or `null`. The `\b429\b` pattern matches `429` as a word-boundary-anchored token (avoiding false positives from arbitrary numbers in log content).

## Gotchas and Pitfalls

1. **Recursive `invoke()` vs `dispatch()`**: Calling `this.invoke()` from within `dispatch()` for the fallback path would cause `fallbackOfInvocationId` on the _new_ request to be misinterpreted as caller-signalled. Always call `dispatch(fallbackRequest, true)` for the fallback hop.

2. **Caller-signalled fallback does not go through `shouldFallback()`**: If a caller sets `fallbackOfInvocationId` on the initial request, the router emits the event and dispatches directly. It does NOT re-evaluate whether escalation is warranted — the router trusts the caller's decision. This was fixed after a review caught that the original `shouldFallback()` returned `true` whenever `fallbackOfInvocationId` was set, causing successful caller-signalled invocations to be discarded.

3. **`fallbackOfInvocationId` on the first row**: When a caller signals fallback via `fallbackOfInvocationId`, the _first_ invocation row already has `fallbackOfInvocationId` set (to the ID of the invocation that failed). The _second_ row (the fallback itself) has `fallbackOfInvocationId` set to the first row's ID. This is correct — the first row records _what it fell back from_, and the second row records _what it fell back from_.

4. **`fallbackProfile` must reference a valid profile with an adapter**: If the configured `fallbackProfile` string doesn't match a profile key, or no adapter is registered for that profile's runtime, the fallback is silently skipped and the original result is returned. The config schema validates `fallbackProfile` references at load time, but the router also guards at runtime.

5. **Event emission is best-effort**: If `eventBus` is not provided in options, `emitFallbackEvent` returns early. This allows tests and non-event contexts to use the router without events.

6. **`AgentInvocationId` import from `@ai-sdlc/domain`**: The `fallbackOfInvocationId` field type uses `AgentInvocationId` from the domain layer, which is a branded type. Import it as `import type { AgentInvocationId } from '@ai-sdlc/domain'` (type-only for layer purity).

7. **Contract violation codes beyond the initial spec**: The implementation added `invalid_result_value`, `missing_commit`, `not_pushed`, and `replies_not_posted` to `CONTRACT_VIOLATION_CODES` beyond what the original issue specified. These are used by other milestones (M4-04, M4-05) and were added preemptively.

8. **The `cancelled_by_orchestrator` → `timeout` reclassification**: Existing logic in `dispatch()` reclassifies `cancelled_by_orchestrator` as `timeout` when the profile's timeout signal fired but the request's abort signal didn't. This reclassification happens _before_ fallback checks, which is correct — it means a timeout-triggered fallback will fire for cancelled orchestrator timeouts.

9. **Layer boundary**: `EventBusPort` is defined in `@ai-sdlc/application` (ports.ts). The router is in `@ai-sdlc/infrastructure`. This is correct — infrastructure can import application ports (inward dependency). Application never imports from infrastructure.

10. **`determineTriggerReason` is asymmetric with `shouldFallback`** — it returns `'runtime_error'` unconditionally for `outcome='failed'`, even when `shouldFallback` would return `false` because `token_limit_exceeded` isn't configured and stderr doesn't match. Safe because `determineTriggerReason` is only called after `shouldFallback` returned `true`. The JSDoc explicitly warns about this.

11. **Stderr scraping is synchronous** — `isTokenLimitError` and `isQuotaError` use `readFileSync`. The stderr file is typically <1KB for error messages, so blocking is negligible. If the stderr file doesn't exist (edge case), the `try/catch` returns `false` — the trigger won't fire, but `runtime_error` catches the failure as a safety net.

12. **Default trigger extension was safe but unobservable** — When `runtime_error` and `token_limit_exceeded` were added to the default set, existing phases without explicit `fallbackTriggers` automatically picked up the new triggers. This is correct because `runtime_error` fires on any `outcome='failed'` (which was always a fail-stop condition), and `token_limit_exceeded` requires stderr pattern matching. But there was no config validation that explicitly acknowledged the change — if an operator explicitly didn't want runtime fallback, they must now set `fallbackTriggers: ['timeout', 'contract_violation']` to opt out.

13. **Router-level trigger detection via stderr scraping is a design choice** — token-limit and quota errors could be detected in the adapter (with structured `contractViolations`) instead of the router (stderr scraping). Router-level detection was chosen because it doesn't change the `AgentPort` / `AgentInvocationResult` interface. Revisit adapter-level detection if stderr scraping proves fragile.

14. **Default triggers test name must stay synchronized** — When `quota_exceeded` was added to the default triggers, the existing test name `'defaults to timeout, contract_violation, runtime_error, and token_limit_exceeded when fallbackTriggers is not set'` needed its name updated. The test still passes because it uses a `timeout` outcome, which is matched before `quota_exceeded` in the switch. The name update matters for maintainers reading test output.

## What to Know Before Modifying This Code

- **Adding a new trigger**: Add the value to `fallbackTriggerSchema` in `packages/shared/src/config/schema.ts`, add a `case` to `shouldFallback()` and `determineTriggerReason()`, and add a test variant in `router-fallback.test.ts`. If the trigger requires stderr pattern matching, add a helper function (`isXxxError()`) following the `isTokenLimitError` pattern.
- **Adding use-case-level triggers**: Set `fallbackOfInvocationId` and `fallbackReason` on the request. No router changes needed — the protocol already supports it.
- **Increasing fallback chain depth**: This would require changing the `isFallback` boolean to a hop counter and is explicitly out of scope (ADR-0007 bounds to one hop). The current one-hop design is intentional.
- **Profile validation at dispatch time**: If `fallbackProfile` references an invalid profile or missing adapter, the fallback is silently skipped. The config schema validates at load time, but if you're dynamically generating configs, validate before dispatch.
- **Adding a new token-limit pattern**: Add a regex to `TOKEN_LIMIT_PATTERNS` in `agent-runtime-router.ts`.
- **Adding a new quota pattern**: Add a regex to `QUOTA_PATTERNS` in `quota-patterns.ts` (used by both adapter and router).
