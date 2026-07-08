---
module: orchestrator
tags: [arbiter, contradiction, runArbiter, phase-registry, layer-boundary, composE-root]
problem_type: design-decision
---

# Arbiter wiring — layer-boundary + phase-registry plumbing (Issue #657)

## Context

`ImplementStepLoop` declares an optional `runArbiter(ctx, tcResult, fixResult)` dependency
in `packages/application/src/implement-step/types.ts:76-80`. The dependency is used
at `packages/application/src/implement-step/implement-step-loop.ts:461-546` to
adjudicate review/fix contradictions: when a 1-shot reconciliation re-run still
fails, the loop asks the arbiter to pick `finding_valid | finding_invalid |
ambiguous | insufficient_evidence` and routes the ruling into either
`'success'`, an extra fix iteration, or `needs_human_review`.

Until this issue, the dependency was never injected from the composition root
(`apps/api/src/compose.ts`), so the loop's `if (deps.runArbiter !== undefined)`
guard short-circuited and every contradiction went straight to a human.

## Decision: closure in compose, no new port

The arbiter is implemented as a closure-local async function inside
`apps/api/src/compose.ts`, exactly mirroring `runImplement` / `runSpecReview`
/ `runQualityReview` / `implRunFix`. We deliberately did **not** introduce
a new `ArbiterPort` in `packages/application/src/ports.ts` plus an adapter in
`packages/infrastructure/src/arbiter/`.

Reasons:

1. **One consumer.** Only `compose.ts` calls the arbiter. No second implementation
   is planned. Per `AGENTS.md`'s port convention, a port is justified only when
   there are multiple adapters or a strong test-isolation reason.
2. **Matches the existing pattern.** Every other step-level agent invocation
   in `compose.ts` is a closure using `artifactAgent.invoke`. A port would
   add a second injection shape for the same call.
3. **Testability is preserved by the existing `compose-arbiter.test.ts`**
   + `implement-step-loop.test.ts:1400-1590` (the loop tests already exercise
   every `runArbiter` outcome exhaustively).

If a second adapter ever appears (e.g. a small-model arbiter with a
deterministic fallback), the right move is to introduce the port at that
time — not now.

## Decision: `phaseId: 'arbiter'` requires a registry entry

`extractResult` in `packages/application/src/results/extract-result.ts:118-120`
throws when `PHASE_RESULT_REGISTRY[invocation.phaseId]` is undefined:

```ts
if (!Object.hasOwn(PHASE_RESULT_REGISTRY, phase)) {
  throw new Error(`no result schema registered for phase '${invocation.phaseId}'`);
}
```

The naive choice — call the agent with `phaseId: 'plan-design'` because the
planner profile is the one we're invoking — fails here: `plan-design` is in
`PHASE_NAME_MIGRATION_MAP` as `null` (no `result.json` produced) AND is not
in `PHASE_RESULT_REGISTRY` (so `extractResult` would throw). Plus, even if
registered, the planner schema (`{ result: 'ready'|'blocked', summary }`)
has the wrong shape for the arbiter.

The smallest correct fix is:

1. New `arbiterResultSchema` in
   `packages/application/src/results/schemas/arbiter.ts`.
2. One new entry in `PHASE_RESULT_REGISTRY`:
   `arbiter: { schema: arbiterResultSchema, retrySafe: true }`.
3. `phaseId: 'arbiter'` on the `artifactAgent.invoke` call from
   `compose.ts`'s `runArbiter` closure.

`'arbiter'` is intentionally NOT added to `PHASE_NAME_MIGRATION_MAP`:
arbiter is a step-internal artefact consumed by the loop only, never
propagated to a phase-level result.json.

## Trade-offs

- `phaseId: 'arbiter'` is a new phase key for accounting purposes; the
  `agentUsageRepository` will bucket arbiter invocations separately from
  `plan-design`. This is desirable for cost tracking — the operator can see
  how often the arbiter fires.
- The `runArbiter` closure reads `result.json` from the most recent spec-review
  and fix invocations via the artifact store. These files live under `cwd`
  (the worktree) because `artifactAgent.invoke` writes them there via the
  durable-artifacts capture path.
- The closure uses `execFileSync('git', ['rev-parse', 'HEAD'], { cwd })` to
  capture the post-fix HEAD so the arbiter's evidence is grounded in the
  current commit, not the run-start commit. This mirrors the
  `runReview`-side pattern at `compose.ts:1410-1414`.

## Superseded: dedicated arbiter profile routing (#669)

The single-consumer framing above (arbiter as a closure-local escalation
step invoked only from `compose.ts`'s `ImplementStepLoop` wiring) has been
superseded by an operator requirement: escalation is error-prone enough
that operators must be able to route the arbiter to a specific model
without a code change.

`apps/api/src/arbiter-profile.ts` now exports `resolveArbiterProfileName`,
resolving `phaseProfiles['arbiter'] -> phaseProfiles['arbitrate'] (legacy
alias) -> phaseProfiles['plan-design'] -> phaseProfiles['fix-review']`.
`compose.ts` calls this helper instead of inlining the `plan-design ??
fix-review` chain. The `arbitrate` key was previously dead — operator
configs declared it but the TS pipeline never consulted it; it is now
live.

The upcoming plan-review loop (#666) will reuse this same helper for its
own arbiter instance, per the single-resolution-site rule recorded in the
helper's docstring.

## Config hygiene and intentional config retention (Issue #662)

To prevent future automated config-hygiene passes from removing "unused-looking" keys, we explicitly document that the following configuration keys in `.ai-orchestrator.json` are live and load-bearing:

- `phaseProfiles['arbitrate']`: Live legacy alias consumed by `resolveArbiterProfileName` in `apps/api/src/arbiter-profile.ts:22`. Pinned by tests in `apps/api/src/arbiter-profile.test.ts`.

Removing any of these keys would silently change runtime behavior and fail the dedicated unit/bats tests. Any static-analysis cleanup tools must walk dynamically-keyed config lookups (e.g. `phaseProfiles[phaseName]`) and fallback tables to avoid false positive detections.
