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

| Owner                   | Triggers                                                                                                            | How                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Router** (mechanical) | `timeout`, `contract_violation` (any), `prompt_budget_exceeded`, `missing_required_artifact`, `invalid_result_json` | Detected from `AgentInvocationResult` after adapter returns                         |
| **Use case** (semantic) | Two consecutive failures, touched-file budget, validation category change, architectural ambiguity                  | Caller sets `fallbackOfInvocationId` + `fallbackReason` on `AgentInvocationRequest` |

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
| `packages/infrastructure/src/agent/__tests__/router-fallback.test.ts`               | 5 adapter-level trigger variants + bounded-chain test                                                                                                              |
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

## Trigger Detection Logic

`shouldFallback(request, result)` returns `true` when:

1. `result.outcome === 'timeout'`, OR
2. `result.outcome === 'contract_violation'` (any violation code)

Note: caller-signalled fallback (`fallbackOfInvocationId` set on initial request) is **not** evaluated by `shouldFallback()` — it's handled earlier in `invoke()`.

`determineTriggerReason(result)` provides a human-readable reason:

- `timeout` → `'timeout'`
- `contract_violation` with `prompt_budget_exceeded` → `'prompt_budget_exceeded'`
- `contract_violation` with `missing_required_artifact` → `'missing_required_artifact'`
- `contract_violation` with `invalid_result_json` → `'invalid_result_json'`
- Any other `contract_violation` → `'contract_violation'`

For caller-signalled fallbacks, the reason comes from `request.fallbackReason ?? 'unknown'`.

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

## What to Know Before Modifying This Code

- **Adding a new trigger**: Add the check in `shouldFallback()` and the reason mapping in `determineTriggerReason()`. Add a test variant in `router-fallback.test.ts`.
- **Adding use-case-level triggers**: Set `fallbackOfInvocationId` and `fallbackReason` on the request. No router changes needed — the protocol already supports it.
- **Increasing fallback chain depth**: This would require changing the `isFallback` boolean to a hop counter and is explicitly out of scope (ADR-0007 bounds to one hop). The current one-hop design is intentional.
- **Profile validation at dispatch time**: If `fallbackProfile` references an invalid profile or missing adapter, the fallback is silently skipped. The config schema validates at load time, but if you're dynamically generating configs, validate before dispatch.
