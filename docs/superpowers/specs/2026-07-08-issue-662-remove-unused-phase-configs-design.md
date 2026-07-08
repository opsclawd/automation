# Design: issue #662 — review the four "unused" `phaseProfiles` entries

## Stated problem

Issue #662 claims that `.ai-orchestrator.json` contains configuration entries
"not present in the runtime codebase" and asks for removal of five keys:

| Key                              | Type / location         |
| -------------------------------- | ----------------------- |
| `phases.wholePrFix`              | retired in #667         |
| `agent.phaseProfiles["whole-pr-fix-review"]` | claimed unused |
| `agent.phaseProfiles["arbitrate"]`           | claimed unused |
| `agent.phaseProfiles["plan-fix"]`            | claimed unused |
| `agent.phaseProfiles["fix-review-architect"]`| claimed unused |

The issue asserts these have no wired consumer and that pnpm build/lint/test
must pass after removal.

## Verified findings (evidence-first)

The investigation contradicts the issue's premise for four of the five keys.
Each is wired into the live TypeScript pipeline (apps/api/src, apps/cli/src,
packages/shared/src, packages/infrastructure/src). The legacy bash orchestrator
under `scripts/legacy/ai-run-issue-v2` is quarantined per #365 and is not part
of the live dispatch path; only its existence can read a key — but the issue
itself does not advance removal-on-quarantine as its rationale.

### `phases.wholePrFix` — ALREADY REMOVED in #667

- `packages/shared/src/config/schema.ts` has **no `wholePrFix` key** (post #667).
- The `.ai-orchestrator.json` shipped with the worktree contains no
  `phases.wholePrFix` block; verification via jq/grep against the file in this
  worktree shows no matches.
- Caps consolidated under `phases.reviewFix.maxConsecutiveFixFailures` and
  `phases.reviewFix.maxTotalFixAttempts` (commit `ec870a21` per
  `docs/solutions/orchestrator/phase-iteration-config-wiring-2026-06-03.md`).
- **Status: no design change needed for this key.** Removing an already-absent
  key is a no-op.

### `phaseProfiles["whole-pr-fix-review"]` — LIVE (fallback in resolver)

- `packages/shared/src/config/phase-fallbacks.ts:2` declares:
  `PHASE_FALLBACKS['whole-pr-fix-review'] = 'fix-review'`.
- `apps/cli/src/run-agent.ts:95-101` (`resolveProfileName`) reads
  `config.phaseProfiles[phaseName]` first, then applies `PHASE_FALLBACKS[name]`
  if the entry is missing. This is the runtime path for `--phase whole-pr-fix-review`.
- `apps/api/src/compose.ts:419` (`resolveProfileForPhase`) is the API mirror
  with the same fallback behavior.
- `scripts/lib/__tests__/run-agent-routing.bats:436` exercises this phase via
  the live CLI (`run-agent.ts uses phaseProfiles for whole-pr-fix-review phase`).
- `packages/infrastructure/src/agent/__tests__/router-phase-normalization.test.ts:17-19`
  pins phase-stem normalization to `'whole-pr-fix-review'`.
- `apps/cli/src/__tests__/run-agent.test.ts:220-309` has 4 tests covering
  explicit / fallback / missing / broken-fallback resolution.
- **Status: load-bearing.** Removing the entry widens the resolver's effective
  profile from explicit `role: "fixer"` to the `fix-review` entry's profile;
  test assertions across the two test suites would fail.

### `phaseProfiles["arbitrate"]` — LIVE (legacy alias in arbiter resolver)

- `apps/api/src/arbiter-profile.ts:22` defines the resolution chain
  `arbiter → arbitrate (legacy alias) → plan-design → fix-review`.
- Per `docs/solutions/orchestrator/arbiter-wiring-2026-07-06.md`, "The
  arbitrate key was previously dead ... it is now live" (post #669).
- Tests: `apps/api/src/arbiter-profile.test.ts` covers the alias.
- The `arbiter` phase is invoked by the plan-review loop in bash scripts
  (`scripts/lib/plan-review.sh` and the live compose dispatch) which resolve
  the profile through the alias chain.
- **Status: load-bearing.** Removing the entry breaks the explicit role
  override (defaults to `plan-design` first, then `fix-review`); changes the
  runtime's profile selection for the arbiter phase.

### `phaseProfiles["plan-fix"]` — LIVE (plan-review loop #666)

- `apps/api/src/compose.ts:2844` invokes
  `resolveProfileForPhaseBound!('plan-fix')` for the plan-fix sub-agent of the
  plan-review loop introduced by #666. Also `compose.ts:2951` and `compose.ts:2983`.
- `scripts/lib/plan-review.sh:744` invokes `run-agent.ts --phase plan-fix` for
  the same sub-phase in the bash dispatch layer.
- **Status: load-bearing.** Removing the entry makes the plan-fix profile
  resolve via the empty `phaseProfiles['plan-fix']` fallback chain
  (none currently configured) → `ConfigError` (`unknown phase: plan-fix`).
  Plan-review loop would no longer complete plan refinement.

### `phaseProfiles["fix-review-architect"]` — LIVE (architect pass #668)

- `apps/api/src/architect-profile.ts:22` defines the resolution
  `fix-review-architect → roles.planner → plan-design`.
- `apps/api/src/compose.ts:3357` references it in an error message and
  `compose.ts:3429` sets `phaseId: 'fix-review-architect'` for the architect
  pass wired by #668.
- `apps/api/src/architect-profile.test.ts` covers this resolution.
- **Status: load-bearing.** Removing the entry changes the architect pass's
  resolved profile from explicit `role: "planner"` to the default `plan-design`
  profile, breaking the agent-pass contract tested in
  `compose-architect-pass.test.ts` and others.

## Recommendation

**Reject the issue's removal proposal as written.** Three of the four
`phaseProfiles` entries are load-bearing in code merged after the issue's
premise was crystallized, and a fourth (`whole-pr-fix-review`) is the named
target of a documented fallback mechanism. Removing them would silently
downgrade (or break) live runtime behavior under tests that assert the
explicit entries.

### Concrete alternatives the issue could legitimately address

If the issue's underlying concern is config hygiene / removing truly dead
config, the only defensible action is the one already taken by #667 —
`phases.wholePrFix`. All four `phaseProfiles` keys should stay.

If the issue's concern is *operator-facing* (a setter reading `.ai-orchestrator.json`
wants unused-looking keys gone), document instead of remove:
- Comment each entry in `.ai-orchestrator.json` with the runtime site that
  consumes it (one-line annotations, e.g. `// consumed by arbiter-profile.ts`
  on the `arbitrate` entry).
- This achieves the spirit of the request (signaling which config is wired)
  without breaking four live resolution paths.

### Files implicated (no edits intended)

- `.ai-orchestrator.json` — proposed removal target; all four `phaseProfiles`
  entries must remain.
- `packages/shared/src/config/phase-fallbacks.ts` — defines
  `PHASE_FALLBACKS['whole-pr-fix-review']`. No change.
- `apps/api/src/arbiter-profile.ts`, `apps/api/src/architect-profile.ts` —
  canonical resolution sites. No change.
- `apps/api/src/compose.ts` — active dispatch for `plan-fix` and
  `fix-review-architect`. No change.
- `apps/cli/src/run-agent.ts` — CLI resolver mirroring the API. No change.
- Test files referenced above — would fail if entries are removed.

## Verification gates (for any PR on this branch)

- `pnpm -r typecheck`
- `pnpm -r test`
- `pnpm lint`
- `pnpm depcruise`

If the issue is reformulated around the documentation change proposed above,
those gates must still pass and the targeted bats test
(`run-agent-routing.bats:436`) must remain green.
