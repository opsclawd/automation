---
title: Deterministic result.json extraction with per-phase Zod schemas
date: 2026-05-25
category: orchestrator
module: packages/application
problem_type: non-deterministic-result-extraction
component: results
symptoms:
  - policy decisions depend on LLM inference to read agent results
  - contract failures silently degrade to defaults instead of failing loudly
  - extractor agent burns tokens on what should be deterministic parsing
root_cause: legacy_hybrid_pattern
resolution_type: feature
severity: high
related_components:
  - packages/application/src/results/extract-result.ts
  - packages/application/src/results/phase-registry.ts
  - packages/application/src/results/schemas/
  - packages/application/src/ports.ts
  - apps/api/src/diagnose-result.ts
  - packages/application/src/__tests__/extract-result.test.ts
  - packages/application/src/__tests__/no-llm-in-extract.test.ts
tags:
  - result-extraction
  - zod
  - deterministic-policy
  - retry-safe
  - contract-violation
  - layer-boundary
---

# Deterministic result.json Extraction with Per-Phase Zod Schemas

## Problem

The orchestrator had no deterministic, typed way to extract an agent invocation's result. The legacy pattern was: read `.result`, fall back to an extractor agent, fall back again to a conservative default. This made contract failures look like recoverable inference problems, burned tokens on unnecessary LLM calls, and hid real bugs behind silent defaults. Policy decisions (phase progression, retry, failure classification) depended on a second LLM call or regex-scraping logs.

Issue #95 / M4-05 (closes #51).

## What Was Decided

Replace the hybrid pattern with a **deterministic-first policy**: parse `result.json` against a per-phase Zod schema, optionally retry once if the phase allows it (`retrySafe: true`), and fail cleanly otherwise. No LLM extraction in the hot path.

### Decision: Per-phase Zod schemas in a registry

Each phase gets its own schema file in `packages/application/src/results/schemas/<phase>.ts`, registered in `PHASE_RESULT_REGISTRY` keyed by phase name string.

**Why not a single union schema?** Phases have different shapes; a union would be unwieldy and adding a new phase requires modifying a large shared file. Separate schema files keep each phase self-contained and easy to verify against captured fixtures.

### Decision: `extractResult` returns a result type, never throws on bad input

```
ExtractResultOutcome = { ok: true, result: T } | { ok: false, reason: 'missing' | 'invalid', detail: string, violationCode: 'invalid_result_json' }
```

Throws only on programmer error (unknown phase). Callers need to distinguish "missing" from "invalid" to decide retry behavior; throwing forces try/catch at every call site and conflates expected business failures with actual bugs.

### Decision: Rerun uses `AgentPort.invoke` with `fallbackOfInvocationId`

When `retrySafe` is true and the result is invalid, `extractResult` calls `ports.agent.invoke()` exactly **once** with `fallbackOfInvocationId` set. This reuses the existing M4-02c protocol — reruns are recorded identically to other fallback invocations.

### Decision: Caller records violations, not `extractResult`

`extractResult` returns `{ ok: false, violationCode: 'invalid_result_json' }` on failure. The caller merges the violation onto the invocation's `contractViolations`. This avoids injecting a mutation callback and keeps `extractResult` side-effect-free aside from the optional rerun.

### Decision: `retrySafe` per phase

| Phase            | `retrySafe` | Rationale                                               |
| ---------------- | ----------- | ------------------------------------------------------- |
| `plan-design`    | true        | Simple JSON; retry likely fixes forgotten `result.json` |
| `plan-write`     | true        | Same as plan-design                                     |
| `implement`      | **false**   | File mutations; rerun risks duplicating changes         |
| `review`         | true        | Simple structured JSON                                  |
| `fix-review`     | **false**   | File mutations (git commits); rerun risks extra commits |
| `create-pr`      | **false**   | Side-effecting; rerun risks duplicate PRs               |
| `pr-review-poll` | **false**   | Posts PR replies; rerun risks duplicate replies         |

## Key Implementation Details

### File structure

```
packages/application/src/results/
  schemas/
    plan-design.ts
    plan-write.ts
    implement.ts
    review.ts
    fix-review.ts
    create-pr.ts
    pr-review-poll.ts
  phase-registry.ts
  extract-result.ts
  index.ts
packages/application/src/__tests__/
  extract-result.test.ts
  no-llm-in-extract.test.ts
  __fixtures__/result-json/<phase>/valid.json   (7 files)
apps/api/src/diagnose-result.ts                  (diagnostic only)
```

### `extractResult` flow (`packages/application/src/results/extract-result.ts`)

1. Look up phase in `PHASE_RESULT_REGISTRY` — throw if unknown (programmer error)
2. If no `resultJsonPath` on invocation → return `{ ok: false, reason: 'missing' }`
3. Read artifact via `ports.artifacts.read(runId, resultJsonPath)` — on error → return `{ ok: false, reason: 'missing' }`
4. `JSON.parse` + `schema.safeParse` — on failure → enter retry-or-fail path
5. On success → return `{ ok: true, result: parsed.data }`

Retry-or-fail: 6. If `retrySafe` is false OR `resultJsonPath` is missing OR `rerunContext` is not provided → return failure 7. Call `ports.agent.invoke(buildRetryRequest(...))` exactly **once** with `fallbackOfInvocationId` 8. Re-read and validate the new invocation's result — if still invalid, return failure (no third call)

### `RerunContext` (`cwd`, `repoId`)

`AgentInvocation` does not carry `cwd` or `repoId`, but `AgentInvocationRequest` requires them. The caller provides these via `ExtractResultInput.rerunContext`. If `rerunContext` is omitted, the retry branch is skipped even for `retrySafe: true` phases.

### Zod dependency

`zod` (`^3.23.8`) was added as a **direct dependency** of `@ai-sdlc/application` (in `packages/application/package.json`). Previously, `zod` was only in `@ai-sdlc/shared`; adding it directly avoids reaching across packages for runtime validation. Use the same version to avoid duplicate copies.

### Diagnostic CLI (`apps/api/src/diagnose-result.ts`)

Reads a `result.json` file by path, parses against the registry, prints result. **Not imported by any production module.** Operators invoke manually for offline inspection. A grep test enforces this.

## Gotchas and Pitfalls

1. **No captured `result.json` files exist in the repo.** All 7 schemas use shapes inferred from the issue spec, documented in header comments. When actual agent runs produce `result.json` files, schemas must be updated to match. This is the biggest risk: schema drift where agent output evolves but schemas don't.

2. **`resultJsonPath` is optional on `AgentInvocation`.** Some invocations (e.g., timed-out) may not have a path. Extraction returns `{ ok: false, reason: 'missing' }`. The `extractResult` function also skips retry when `resultJsonPath` is missing, even for `retrySafe: true` phases — the rationale is that invocations without a result artifact path are unlikely to benefit from a rerun.

3. **Rerun prompt quality.** The rerun re-invokes with `fallbackOfInvocationId` set but no improved prompt. The contract-violation reminder prepend is a future M8 concern. Without it, the rerun may produce the same invalid output. The failure is still caught cleanly; no silent degradation.

4. **FakeAgentPort invocation count semantics.** `FakeAgentPort.invocations` tracks only calls made by `extractResult`, not the original invocation. The original invocation happened before `extractResult` was called. Therefore: branch (b) = 1 call, branch (c) = 1 call, branch (d) = 0 calls. These counts reflect `AgentPort.invoke` calls made by `extractResult`, not total invocations.

5. **The grep test (`no-llm-in-extract.test.ts`) reads source as text.** It asserts `ports.agent.invoke` appears exactly once in `extract-result.ts`. If a future refactor moves logic to a helper file, the test must be updated to walk imports. `depcruise` provides a second line of defense.

6. **`buildRetryRequest` uses `as unknown as string` casts.** `invocation.runId`, `invocation.phaseId`, and `invocation.id` are branded types. The function casts them to `string` for `AgentInvocationRequest`, which expects plain strings. This is intentional — the branded types provide domain-level type safety while the request interface uses primitives.

7. **`implement` is `retrySafe: false` for a reason.** It performs file mutations. Rerunning after invalid output risks duplicating changes. Similarly, `create-pr` is side-effecting (risk of duplicate PRs). Do not change these to `true` without careful analysis.

8. **Branch `(b)` test uses `FakeAgentPort` with scripted responses.** The key `'p'` must match the invocation's `profile`. If the profile name changes in the test, the fake won't find the scripted response and will throw "No scripted response for profile."

## Lessons Learned

1. **Result-type return over throwing.** Never throw on expected business failures (missing file, invalid schema). Return structured failure info so callers can make policy decisions. Throw only on programmer errors (unknown phase).

2. **Inject ports, don't import infrastructure.** `extractResult` receives `ArtifactStore` and `AgentPort` via dependency injection through `ports`. This keeps `packages/application` free of `@ai-sdlc/infrastructure` imports, enforced by `depcruise`.

3. **Grep tests as architectural guardrails.** The `no-llm-in-extract.test.ts` test is a lightweight way to enforce architectural constraints (no extra LLM calls) that `depcruise` can't check. It reads source code as text and counts pattern matches. Useful when the constraint is behavioral, not structural.

4. **Parameterized tests scale well for multi-phase policies.** Using `describe.each(PHASE_TESTS)` with 7 phases x 4 branches keeps the test count manageable while ensuring every phase gets the full test coverage. Adding a new phase means adding one entry to the `PHASE_TESTS` array.

5. **Zod must be a direct dependency of the consuming package.** Even though `@ai-sdlc/shared` already has `zod`, `packages/application` needs its own direct dependency to avoid reaching across workspace packages. Use the same version (`^3.23.8`) to avoid duplicate copies in the bundle.

6. **Caller-side violation recording pattern.** `extractResult` signals violations via the return value; the caller records them on the domain object. This keeps the function side-effect-free (aside from the optional rerun) and testable without mocking a mutation port.

## What to Know Before Modifying This Code

- **Adding a new phase:** Create a schema file in `packages/application/src/results/schemas/`, add it to `PHASE_RESULT_REGISTRY` in `phase-registry.ts`, add the barrel export in `index.ts`, add a fixture in `__fixtures__/result-json/<phase>/valid.json`, and add an entry to the `PHASE_TESTS` array in `extract-result.test.ts`.

- **Changing a schema shape:** Update the schema file, then update the corresponding fixture in `__fixtures__/result-json/`. If captured `result.json` files from actual runs exist, prefer their shapes over the illustrative ones.

- **Changing `retrySafe` for a phase:** Think carefully. `implement` is `false` because reruns risk duplicating file mutations. `fix-review` is `false` because the phase commits changes (rerun risks extra commits). `create-pr` is `false` because reruns risk creating duplicate PRs. `pr-review-poll` is `false` because it posts PR replies (rerun risks duplicate replies). Only change to `true` if the phase is truly idempotent or safe to retry.

- **The diagnostic CLI** (`apps/api/src/diagnose-result.ts`) must never be imported by production code. The grep test and PR review process enforce this. If you need programmatic validation in the hot path, use `extractResult` instead.

- **`buildRetryRequest`** constructs the rerun request from the original invocation. If `AgentInvocationRequest` gains new required fields, this function must be updated too.

- **`readAndValidate`** is a private helper that reads, parses, and validates. It's called twice in the retry path (once for original, once for rerun result). If you add side effects here, they'll happen on every validation attempt.
