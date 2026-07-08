---
module: orchestrator
tags: [config, phase-registry, phaseProfiles, issue-662]
problem_type: best-practice
---

# Phase Profile Configuration Retention (Issue #662)

To prevent future automated config-hygiene passes from removing "unused-looking" keys, we explicitly document that the following configuration keys in `.ai-orchestrator.json` are live and load-bearing:

- `phaseProfiles['plan-fix']`: Consumed by `compose.ts:2844` (`planFixProfileName`), with prompt template lookup at `compose.ts:2951` and dispatch under `phaseId: 'plan-fix'` at `compose.ts:2983`. Pinned by tests in `apps/api/src/__tests__/compose-plan-review.test.ts:25-50`.
- `phaseProfiles['whole-pr-fix-review']`: Live fallback target mapped to `'fix-review'` via `PHASE_FALLBACKS` fallback table in `packages/shared/src/config/phase-fallbacks.ts:2`. Pinned by tests in `packages/shared/src/config/__tests__/phase-fallbacks.test.ts`, `apps/api/src/__tests__/compose-agent.test.ts:65-110`, `apps/cli/src/__tests__/run-agent.test.ts:220-310`, and `scripts/lib/__tests__/run-agent-routing.bats`.

Removing any of these keys would silently change runtime behavior and fail the dedicated unit/bats tests. Any static-analysis cleanup tools must walk dynamically-keyed config lookups (e.g. `phaseProfiles[phaseName]`) and fallback tables to avoid false positive detections.
