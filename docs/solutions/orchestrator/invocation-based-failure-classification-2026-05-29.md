---
title: Invocation-based failure classification — structured outcomes over regex scraping
date: 2026-05-29
category: orchestrator
module: packages/infrastructure
problem_type: pattern
component: classifier
severity: high
symptoms:
  - Failure classifier matched /timed? out/ against vitest test names in combined log tail
  - Model-not-found errors classified as "timeout" with test name as message, hiding real error
  - Combined log tail mixes output from all phases, contaminating failure messages
root_cause: fragile_regex_scraping
resolution_type: implementation
tags:
  - classifier
  - failure-classification
  - invocation
  - compose
  - enrichment
  - precedence
related_components:
  - packages/infrastructure/src/failure/classifier.ts
  - packages/domain/src/classify-exit.ts
  - apps/api/src/compose.ts
  - packages/infrastructure/src/failure/__tests__/classifier.test.ts
---

# Invocation-Based Failure Classification — Structured Outcomes over Regex Scraping

## Problem

`classifyExit()` matched `/timed? out|TIMEOUT/i` against the last 8000 chars of **combined stdout/stderr** (which mixes output from all phases, including unrelated test output from the validate phase). When a vitest test name like `PiAgentAdapter > returns timeout when child exceeds timeout` appeared in the log tail, the failure was classified as `kind='timeout'` with the test name as the message — hiding the real error (`Model not found: opencode/deepseek-v4-flash`).

## Solution: Three-Tier Classification Precedence

The classifier now uses a precedence system. Each tier is checked before falling through to the next:

```
Failure input
  ├─ [1] Event-based (existing)
  │       Carries structured metadata (missingArtifact, command, reason)
  │       Most reliable — checked first
  │
  ├─ [2] Invocation-based (NEW)
  │       Uses structured outcome from AgentInvocation
  │       Message sourced from agent stderr, not combined log tail
  │
  ├─ [3] Regex log-scraping (existing, last resort)
  │       For failures without agent invocations
  │       (orchestrator git failures, bash script errors, etc.)
  │
  └─ [4] Fallback: command_failed / unknown (existing)
```

## Key Implementation Decisions

### 1. Optional `invocation` field on `ClassifyExitInput`

`packages/domain/src/classify-exit.ts`:

```typescript
invocation?: {
  outcome: AgentInvocationOutcome;
  stderrContent?: string;
  contractViolations?: string[];
};
```

`stderrContent` is a pre-read string, so the classifier (in infrastructure) doesn't need filesystem access. The caller (`compose.ts`) reads stderr and passes the content. The `outcome` type uses `AgentInvocationOutcome` from the domain layer (shared type prevents drift from hardcoded union strings).

### 2. `compose.ts` enrichment adapter

`apps/api/src/compose.ts` wraps the `classifyExit` function with an adapter that looks up the latest invocation, reads its stderr, and enriches the input:

```typescript
const classifyExitAdapter = (
  agentInvocationRepository: AgentInvocationRepository,
): ClassifyExitFn => {
  return (input) => {
    let enriched = input;
    try {
      const invocations = agentInvocationRepository.listByRun(RunId(input.runUuid));
      const latest = invocations[invocations.length - 1];
      if (latest && latest.outcome && latest.outcome !== 'success' && latest.stderrPath) {
        let stderrContent: string | undefined;
        try {
          stderrContent = readFileSync(latest.stderrPath, 'utf-8');
        } catch {}
        enriched = {
          ...input,
          invocation: {
            outcome: latest.outcome,
            stderrContent,
            contractViolations: latest.contractViolations,
          },
        };
      }
    } catch {}
    return classifyExit(enriched);
  };
};
```

Key detail: if the last invocation's outcome is `'success'` (fallback succeeded), invocation enrichment is skipped — no need to classify a successful run. If the fallback failed, the last invocation's failure is what gets classified — this is correct.

### 3. `buildFailureFromInvocation()` — structured outcome → failure kind

Inserted into the classifier at `classifier.ts:129`, between the event path and regex scraping:

```typescript
if (input.invocation && input.invocation.outcome !== 'success') {
  const fromInvocation = buildFailureFromInvocation(input);
  if (fromInvocation !== null) return fromInvocation;
}
```

Mapping:

| `invocation.outcome`                               | Failure `kind`     | Message source                                        |
| -------------------------------------------------- | ------------------ | ----------------------------------------------------- |
| `timeout`                                          | `timeout`          | `inv.stderrContent` or `"Agent invocation timed out"` |
| `failed`                                           | `command_failed`   | `inv.stderrContent` or `"Agent invocation failed"`    |
| `contract_violation` + `prompt_budget_exceeded`    | `missing_artifact` | `"Prompt budget exceeded"`                            |
| `contract_violation` + `missing_required_artifact` | `missing_artifact` | `inv.stderrContent` or `"Missing required artifact"`  |
| `contract_violation` (other)                       | `command_failed`   | `inv.stderrContent` or `"Contract violation"`         |

The critical fix: **message is sourced from `invocation.stderrContent`** (the agent's stderr), not from `combinedLogTail` (which mixes output from all phases). This prevents test names, earlier-phase output, and other noise from contaminating the failure message.

## Phase-Matching Guard: Added and Removed

The initial implementation added a guard that required `invocation.phaseId === terminalEvent.phase` in the compose enrichment adapter. The guard was designed to prevent a non-terminal phase's failure (e.g., a non-fatal extractor failure) from being misattributed to a terminal bash-level failure.

**Why it was removed:** The orchestrator's bash wrapper (`scripts/ai-run-issue-v2`) maps multiple dynamic subphase IDs to the same enclosing `LAST_PHASE` in events. Subphases like `implement-task-1`, `quality-review-task-2`, `fix-review-N` use dynamic IDs that never match the enclosing `LAST_PHASE` string. The guard blocked enrichment for **every** subphase failure.

The guarded-against scenario cannot materialize in the runtime: `orchestrator_fail` calls `exit 1` on the first fatal agent error, so there is never a later bash-level failure to confuse with a prior non-fatal extractor failure.

**Lesson:** Speculative guards added to prevent theoretical false-positives can produce guaranteed false-negatives. Verify the guarded-against scenario's runtime feasibility before coding the guard, especially when the guard relies on name-matching across two naming systems (agent_invocations IDs vs bash event phases).

## Classifier Precedence Details

### Event-based (tier 1)

`buildFailureFromEvent()` checks for terminal events with structured metadata (`missingArtifact`, `command`, `reason`). Returns `null` if no matching rule exists for the event type. Events always take precedence because they carry the richest metadata.

### Invocation-based (tier 2)

Only fires when `input.invocation` is present AND `outcome !== 'success'`. This means:

- Non-agent failures (orchestrator git failures, bash script errors) still fall through to regex scraping — correct, since there's no invocation to analyze.
- Successful invocations are skipped — no need to classify a non-failure.

### Regex scraping (tier 3)

Unchanged from the legacy behavior. Matches patterns in `combinedLogTail`. Still needed for:

- Orchestrator-level script failures (git merge conflicts, bash parse errors)
- Failures that occur before any agent invocation (config loading, worktree setup)
- Edge cases where invocation data is unavailable

## What to Know Before Modifying This Code

- **Changing the failure message source:** The message comes from `invocation.stderrContent` in `buildFailureFromInvocation()`. To fall back to `combinedLogTail` instead, change the `message` assignment. The current design deliberately uses stderr to avoid contamination.
- **Adding new invocation → FailureKind mappings:** Add a branch in `buildFailureFromInvocation()`. The domain type `ClassifyExitInput.invocation.contractViolations` is where contract-violation codes flow through.
- **The domain type `ClassifyExitInput.invocation` is a pure data object:** No I/O. The caller (`compose.ts`) reads stderr and passes the content. Any new fields must also be pure data.
- **Classifier precedence matters:** New tiers should be inserted carefully. Event-based classification has primacy because events carry richer metadata. Don't add a new tier without considering how it interacts with existing patterns.
- **Testing patterns:** Six new tests in `classifier.test.ts` cover: prevention of timeout misclassification, stderr-sourced message, fallthrough to regex when no invocation data, event priority over invocation, `outcome='success'` skip behavior, and fallback message when stderr is absent.

## Related

- Issue #125 — original bug report (classifier fix = Part B)
- PR #130 — part of the same changeset
- `docs/solutions/orchestrator/agent-fallback-triggers-2026-05-23.md` — companion doc for router-side fallback triggers (Part A)
