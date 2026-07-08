---
module: orchestrator
tags: [composition-root, review-fix, architect, parity]
problem_type: pattern
---

# Architect pass wiring (Issue #668)

## Problem

The TS review-fix loop accepts an `architectPlan` on its input and the `run-review-fix` CLI takes `--architect-plan-json`, but nothing in the TS executor ever generated that plan. Legacy (`scripts/legacy/ai-run-issue-v2:4338-4457`) called a `fix-review-architect` agent before the fix loop, but the TS port had no equivalent — the feature was silently off regardless of config.

## Solution

A `maybeRunArchitect` closure lives in `apps/api/src/compose.ts` next to the existing `runReview`/`runFix` helpers. It runs once per review-fix phase, immediately before `reviewFixLoopInstance.execute(...)`, and is invoked from inside `ReviewFixHandler.runLoop` (`apps/api/src/compose.ts` — see registration block).

The closure:

1. Returns `undefined` when `phases.reviewFix.architectPass.enabled` is false (emits `review_fix.architect_pass_skipped reason=disabled`).
2. Reads the review manifest; returns `undefined` if there are zero `action=fix` entries (emits `architect_pass_skipped reason=no_fix_tasks`).
3. Resolves the profile via `resolveArchitectProfileName` (`apps/api/src/architect-profile.ts`). Resolution order: `phaseProfiles['fix-review-architect'].profile` → `roles.planner.profile` → `phaseProfiles['plan-design'].profile` → `undefined`. The dedicated key exists so operators can route the architect to a slower model without changing plan-design's profile.
4. Captures pre-architect HEAD, builds a read-only prompt via `buildArchitectPrompt` (`apps/api/src/architect-prompt.ts`), and calls `artifactAgent.invoke` with `phaseId: 'fix-review-architect'`, `expectedArtifacts: ['review-fix-plan.json']`, and `timeoutMs: timeoutMinutes * 60_000`.
5. Performs the mutation guard (`git diff --exit-code <preArchitectSha> -- .` against the inlined orchestrator-diff exclusions). Non-empty diff → `git reset --hard <preArchitectSha>`, emit `architect_pass_failed reason=mutation`, return `undefined`.
6. Reads `review-fix-plan.json`, validates with `architectPlanSchema` (Zod, `packages/application/src/results/schemas/architect.ts`). Failure → `architect_pass_failed reason=invalid_structure|no_output`, return `undefined`.
7. On success → emit `architect_pass_completed tasks=<count>` and return the validated plan to the loop as `architectPlan`.

## Key decisions

- **Closure, not port.** The architect has exactly one consumer. The arbiter-wiring solution documented that ports are justified only for multiple adapters or strong test-isolation reasons; neither applies here.
- **Fail-soft, not fail-hard.** The architect is a quality-of-fix enhancer, not a correctness gate. The loop converges without a plan (the existing `architectPlan?: undefined` path is the default). A failed architect must not turn a passing run into a failing one.
- **No phase-registry entry.** The architect is a step-internal artefact. `agentInvocationRepository` already keys invocations by `phaseId`, so the cost bucket appears under `fix-review-architect` automatically.
- **Mutation guard pre-read.** Architect is read-only. The hard-reset fires *before* `review-fix-plan.json` is read, so a mutated plan is never used.
- **Default `enabled: false`.** Preserves the current "feature is silently off" behavior. Operators opt in explicitly.

## Tests

- `packages/application/src/results/schemas/__tests__/architect.test.ts` — Zod schema unit tests (7 cases).
- `apps/api/src/architect-profile.test.ts` — profile resolution chain (7 cases).
- `apps/api/src/__tests__/architect-prompt.test.ts` — prompt structure (6 cases).
- `apps/api/src/__tests__/compose-architect.test.ts` — integration: schema export, registry absence, prompt contents, source-level wiring (8 cases).
