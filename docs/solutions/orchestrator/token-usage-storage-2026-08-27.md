---
title: Token usage storage — where phase token counts are persisted and how to query them
date: 2026-08-27
category: orchestrator
module: packages/infrastructure
problem_type: feature
component: agent-runtime-router
symptoms:
  - terminal shows "<phaseId>: X in / Y out tokens" lines but the orchestrator repo's sqlite db has no agent_usage rows
  - cost-by-phase queries return $0 even though token counts are clearly non-zero
  - post-PR-#1058 investigation can't tell which adapters still fall through to "unknown"
root_cause: discoverability
resolution_type: documentation
severity: low
related_components:
  - packages/infrastructure/src/agent/agent-runtime-router.ts
  - apps/api/src/compose.ts
  - apps/api/src/cli.ts
  - apps/api/src/cli.ts:761
  - packages/infrastructure/src/sqlite/agent-usage-repository.ts
  - migrations 0036-agent-usage-status
tags:
  - token-usage
  - observability
  - agent-usage
  - persisting-event-bus
  - agent-runtime-router
  - v_usage_by_phase
  - v_cost_by_phase
  - target-repo-root
  - pr-1058
---

# Token Usage Storage

## Problem

The orchestrator prints `<phaseId>: X in / Y out tokens` lines to the terminal during runs, but the orchestrator repo's local `.ai-runs/orchestrator.sqlite` appears empty. The data exists — it is just in a different sqlite file depending on which target repo the run was executing against.

## Where the data lives

Per-invocation token counts land in the **target repository's** sqlite db:

```
<target-repo-root>/.ai-runs/orchestrator.sqlite
```

NOT the orchestrator repo's `apps/api/.ai-runs/orchestrator.sqlite`. The `--target-repo-root` CLI flag (and the registered-target-repo fallback) drives which db `composeWithTarget` opens at `apps/api/src/cli.ts:599`.

For example, a run started with:

```
pnpm run:preflight --issue 113 --target-repo-root /home/gary/.openclaw/workspace/comfy-content-orchestrator
```

writes to `/home/gary/.openclaw/workspace/comfy-content-orchestrator/.ai-runs/orchestrator.sqlite`, not to the automation repo's db.

## Schema

Migration `0036-agent-usage-status` adds the `agent_usage` table:

- `invocation_id`, `run_uuid`, `phase_id`, `profile`, `provider`, `model`
- `usage_status` — `'measured'` if the adapter returned real usage, `'unknown'` if it fell through
- `input_tokens`, `output_tokens`, `reasoning_tokens`, `cached_tokens` (nullable when status='unknown')
- `recorded_at`

Two views ship alongside:

- **`v_usage_by_phase`** — token totals grouped by `(phase_id, profile, provider, model)`. Has columns `total_input_tokens`, `total_output_tokens`, `total_reasoning_tokens`, `total_cached_tokens`, `invocation_count`, `unknown_invocation_count`.
- **`v_cost_by_phase`** — same shape but joins `model_prices` to compute `estimated_cost_usd`.

## Trace: terminal print vs db write

Single publish site — `packages/infrastructure/src/agent/agent-runtime-router.ts:507-535` — emits the `agent.usage` event:

```ts
type: 'agent.usage',
message: `${request.phaseId}: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens`,
metadata: { phase, phaseId, profile, provider, model, inputTokens, outputTokens, reasoningTokens?, cachedTokens?, durationMs, usageSourcePaths? },
```

The event is published through `this.opts.eventBus`, which is wired to `persistingEventBus` at `apps/api/src/compose.ts:2858`.

`persistingEventBus.publish` (`apps/api/src/compose.ts:2399-2430`) does two things on every event:

1. `eventBus.publish(runUuid, event)` — the underlying `InMemoryEventBus`. The CLI tee at `apps/api/src/cli.ts:761-765` subscribes here and prints `console.error(`[ts] ${event.message}`)` for events passing `shouldStreamEventToCli`.
2. `eventRepositoryFactory(rId).insert({...})` — persists to the events table with no filtering.

So: **what shows in the terminal is also being written to the events table**, and `EventRepository.insert` will reach it regardless of CLI tee state. If you can see the line, it is in the db.

`agent_usage` rows come from a separate path — `agent-runtime-router.ts:442-472` calls `usageRepository.insert` with `status: 'measured'` when `result.usage` is defined, or `status: 'unknown'` when undefined. The db `events` row contains the human-readable message; the `agent_usage` row is the structured numeric record.

## PR #1058 status (token-source adapters)

PR #1058 (merged 2026-08-26 11:16 UTC, "Wire up real token-usage sources for opencode, claude-code, and antigravity") fixes:

- `opencode-adapter` — reads from `opencode.db` session table instead of returning undefined
- `claude-code-adapter` — parses `--output-format json` envelope for `usage.input_tokens` / `output_tokens`
- `antigravity-adapter` — same json envelope path
- `codex-adapter` — uses correct field names `cached_input_tokens` / `reasoning_output_tokens`

Verified post-merge measured rate against the comfy-content-orchestrator db:

| Window | measured | unknown |
|---|---:|---:|
| Pre-merge (< 2026-08-26 11:16 UTC) | 33 | 1500 |
| Post-merge (>= 2026-08-26 11:16 UTC) | **271** | **3** |

Post-merge unknown breakdown by provider:

- google: 1
- minimax-coding-plan: 2
- openai, anthropic: 0

PR #1058 is effectively fixed. The 3 residual unknowns post-merge warrant a separate triage, not a revert.

## Token totals by phase (post-merge, measured)

| Phase | Total I/O tokens | Invocations | Avg per call |
|---|---:|---:|---:|
| implement | 12,570,055 | 36 | 349K |
| fix-review | 9,761,251 | 27 | 362K |
| plan-write | 7,859,351 | 7 | **1,123K** |
| quality-review | 5,959,449 | 70 | 85K |
| spec-review | 5,360,539 | 68 | 79K |
| plan-design | 4,689,597 | 6 | 782K |
| plan-review | 3,514,847 | 22 | 160K |
| whole-pr-review | 3,306,112 | 13 | 254K |
| plan-fix | 1,023,129 | 6 | 171K |
| post-pr-review | 975,211 | 7 | 139K |
| compound | 139,818 | 6 | 23K |
| arbiter | 110,027 | 2 | 55K |
| implement.synthesize | 49,369 | 1 | 49K |

Notable: `implement` shows a ~94% cache hit rate (183M cached vs 11.4M fresh input), confirming cache-aware pricing matters even when raw `input_tokens` looks modest.

## Known gap: `v_cost_by_phase` returns $0

`v_cost_by_phase` joins `model_prices` to compute `estimated_cost_usd`, but the `model_prices` table has no rows for any provider actually in use (`google`, `minimax-coding-plan`, `openai`, `anthropic` against this target repo's run history). Without price rows, the `COALESCE(p.input_price_per_1k_tokens, 0)` falls through to 0 and the cost column is uniformly zero.

To restore cost reporting, populate `model_prices` for the providers/models actually in use. The cost formula itself is correct (handles cached-vs-fresh split).

## Query recipes

Top token-consuming phases post-merge:

```sql
SELECT phase_id,
       SUM(input_tokens) AS total_input,
       SUM(output_tokens) AS total_output,
       SUM(input_tokens + output_tokens) AS total_io,
       COUNT(*) AS invocations
FROM agent_usage
WHERE recorded_at >= '2026-08-26T11:16:00Z'
  AND usage_status = 'measured'
GROUP BY phase_id
ORDER BY total_io DESC;
```

Per-run totals:

```sql
SELECT * FROM v_usage_by_run
ORDER BY total_input_tokens DESC
LIMIT 20;
```

Cache hit rate per phase:

```sql
SELECT phase_id,
       SUM(input_tokens) AS fresh,
       SUM(COALESCE(cached_tokens, 0)) AS cached,
       ROUND(100.0 * SUM(COALESCE(cached_tokens, 0)) /
             NULLIF(SUM(input_tokens + COALESCE(cached_tokens, 0)), 0), 2) AS cache_pct
FROM agent_usage
WHERE usage_status = 'measured'
GROUP BY phase_id
ORDER BY cached DESC;
```

## Related

- `apps/api/src/cli.ts:761-765` — CLI tee subscription (raw `InMemoryEventBus`)
- `apps/api/src/compose.ts:2399-2430` — `persistingEventBus.publish` (fan-out to tee + db)
- `packages/infrastructure/src/agent/agent-runtime-router.ts:442-472` — `usageRepository.insert` (structured numeric record)
- `packages/infrastructure/src/agent/agent-runtime-router.ts:507-535` — `agent.usage` event publish (terminal-visible message)
- `packages/infrastructure/src/sqlite/agent-usage-repository.ts` — repo implementation
- `apps/api/migrations/0036-agent-usage-status.ts` — schema
