# M8-06: review-fix Phase Handler + Coordinated Rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `review-fix` phase handler that drives the existing M7 `ReviewFixLoop`, and perform the **coordinated, atomic** rename that collapses the shipped `whole-pr-review` + `fix-review` observability phases into the single domain-canonical `review-fix` phase across config, code, tests, and docs.

**Architecture:** The M7 loop already exists (`packages/application/src/review-fix/review-fix-loop.ts`) and `compose.ts` already runs it under a `review-fix` phaseId. The thin `ReviewFixHandler` wraps it as a `PhaseHandler`. The rename is the bulk of the work: it is a **semantic** consolidation across ~6 production files plus tests/config/docs, **not** a blind find-and-replace — several legacy names are profile-routing keys or loop-internal names that must be reconciled carefully.

**Tech Stack:** TypeScript (strict, ESM), Vitest, Next.js (timeline UI), SQLite migrations, `.ai-orchestrator.json`.

---

## ⚠️ Critical context — DO NOT blind-replace

The legacy names appear in **distinct roles** that map differently. From the current repo:

- **Observability phase names** (collapse these): `apps/web/src/lib/timeline.ts` `CANONICAL_PHASES` has `whole-pr-review` and `fix-review` as two separate timeline phases → these become one `review-fix`.
- **Result schemas** (`packages/application/src/results/phase-registry.ts`): keys `whole-pr-review`, `fix-review` (also `spec-review`, `quality-review`, `fix-validate`). `extract-result.ts` strips a trailing `-N`. Decide whether `review-fix` gets a new combined schema or reuses `whole-pr-review` for the review step + `fix-review` for the fix step **inside the loop** (the loop runs both sub-steps). The phase-level result for `review-fix` is the loop's terminal verdict.
- **Profile routing keys** (`.ai-orchestrator.json` `phaseProfiles`, and `packages/shared/src/config/phase-fallbacks.ts`): `fix-review`, `whole-pr-fix-review`, `whole-pr-review`, `fix-review-architect`. These are **per-agent-call routing keys used inside the loop**, not necessarily timeline phases. The `review-fix` *phase* may keep using these sub-keys internally for its review vs. fix vs. architect calls. **Confirm with the maintainer** which keys collapse and which stay as loop-internal routing keys.
- **DB migration**: `0004-phase-rename.ts` already backfilled `review→whole-pr-review`. A **new migration** (`0009-review-fix-rename.ts`) must backfill persisted rows `whole-pr-review`/`fix-review` → `review-fix` for the timeline-phase columns (`runs.current_phase`, `runs.completed_phases`, `phases.name`, `events.phase`, `artifacts.phase`, `failures.phase`) — but **not** `agent_invocations.phase_id` if those rows record loop-internal sub-step names you decide to keep.
- **`compose.ts`** already passes `'review-fix'` as the phaseId to `ReviewFixLoop` (lines ~431, ~598). So the executor-side phase name is already `review-fix`; the gap is the timeline/classifier/config/result-schema surfaces.
- **The classifier** (`packages/infrastructure/src/failure/classifier.ts`) references `fix-review` in its loop-exhaustion messaging (~lines 220/223/252/284).

**`fix-validate` is OUT OF SCOPE** — it belongs to the validate loop, not the review collapse. Leave it intact.

## ⚠️ Parity gate — this PR touches a watched legacy path

This story edits `scripts/ai-run-issue-v2` (and `scripts/lib/detect-phase.sh`), which are **watched legacy paths**. The required CI parity gate (`scripts/check-parity-coverage.sh`, issue #292) will **block this PR** unless it adds/extends a `parity[#NNN]` test, or a human adds a `no-parity-impact` note to the PR body. **The autonomous loop cannot self-declare `no-parity-impact`** (the `IMPLEMENTER_PROMPT`/`PLAN_WRITE_PROMPT` rules say so explicitly) — so expect this PR to go red on the parity gate and require a human to add the note/test. Plan for that hand-off; do not spin retrying CI.

**Parity rows this rename must keep green (and update in lockstep where the phase name appears):**

- `parity[#337]` — review-fix CLI delegation captures exit code before `guard_artifact_clean`; the legacy fix-review loop is replaced by CLI delegation with a post-loop guard.
- `parity[#274]` — fix-review reverts task commits when revalidate is red.
- `parity[#281]` — stash/commit (never blind `reset --hard`) before cleaning.
- `parity[#282]` — an all-deferred manifest yields zero actionable fix tasks (success, not crash).
- `parity[#283]` — findings text is carried through fix iterations.
- **`parity[#339]` — ⚠️ directly impacted by the rename.** It pins *"fix-validate passed state survives `guard_artifact_clean` and resumes at `whole-pr-review`."* Renaming `whole-pr-review` → `review-fix` changes that resume target, so **this parity test must be updated in the same PR** (its assertion string and the behavior it pins both move to `review-fix`). Add this to the Task 0 decision matrix.

Run `bash scripts/check-parity-coverage.sh` locally before pushing to see exactly what the gate will flag.

## Task 0 (MANDATORY FIRST): Build the inventory + decision matrix

- [ ] **Step 1: Generate the authoritative inventory:**

```bash
cd <repo>
grep -rn "whole-pr-review\|whole-pr-fix-review\|fix-review-architect\|fix-review\|review-fix" \
  apps packages scripts .ai-orchestrator.json \
  | grep -v node_modules | grep -v '/dist/' | grep -v '/.next/' \
  > /tmp/review-rename-inventory.txt
cat /tmp/review-rename-inventory.txt
```

- [ ] **Step 2: Classify every hit** into one of: (A) timeline/observability phase name → collapse to `review-fix`; (B) result-schema key → reconcile; (C) profile-routing/loop-internal key → likely keep; (D) test/docs → update to match the decision. Write the classification as a checklist in the PR description.

- [ ] **Step 3: Confirm the decision matrix** with the maintainer (comment on the issue) **before** editing. Specifically confirm: do `whole-pr-fix-review` and `fix-review-architect` stay as loop-internal routing keys?

This task produces no code; it produces the plan-of-record for the edits. **Do not proceed to edits without it.**

---

### Task 1: `ReviewFixHandler` wrapping the M7 loop

**Files:**
- Create: `packages/application/src/phases/handlers/review-fix.ts`
- Test: `packages/application/src/phases/handlers/__tests__/review-fix.test.ts`

- [ ] **Step 1: Write the failing test** — given an injected `ReviewFixLoop`-shaped runner that returns `{ phaseOutcome: 'passed' }` then `{ phaseOutcome: 'failed' }`, the handler maps to `PhaseResult`:

```ts
import { describe, it, expect } from 'vitest';
import { ReviewFixHandler } from '../review-fix.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

function ctx() {
  const events: OrchestratorEvent[] = [];
  return {
    runId: 'r1', runUuid: 'r1', repoFullName: 'a/b', issueNumber: 1, cwd: '/wt',
    artifacts: {} as never, agent: {} as never, git: {} as never, github: {} as never,
    events: { publish: (_u: string, e: OrchestratorEvent) => events.push(e), subscribe: () => () => {} },
    now: () => new Date('2026-06-16T00:00:00Z'),
  } as unknown as PhaseHandlerContext;
}

describe('ReviewFixHandler', () => {
  it('passes when the loop converges', async () => {
    const handler = new ReviewFixHandler({ runLoop: async () => ({ phaseOutcome: 'passed' as const }) });
    expect((await handler.run(ctx())).outcome).toBe('passed');
  });
  it('fails when the loop exhausts', async () => {
    const handler = new ReviewFixHandler({ runLoop: async () => ({ phaseOutcome: 'failed' as const }) });
    const res = await handler.run(ctx());
    expect(res.outcome).toBe('failed');
    expect(res.failure?.kind).toBe('validation_failed');
  });
});
```

- [ ] **Step 2: Run to verify failure.** → FAIL.

- [ ] **Step 3: Implement `review-fix.ts`:**

```ts
import type { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';

export interface ReviewFixHandlerOpts {
  /** Runs the M7 ReviewFixLoop and returns its terminal phase outcome.
   *  Injected so this handler is testable; the executor (M8-10) wires the
   *  real ReviewFixLoop.execute(...) here. */
  runLoop: (ctx: PhaseHandlerContext) => Promise<{ phaseOutcome: 'passed' | 'failed' }>;
}

export class ReviewFixHandler implements PhaseHandler {
  readonly phase = 'review-fix' as PhaseName;
  constructor(private readonly opts: ReviewFixHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    this.emit(ctx, 'phase.started', 'info', 'review-fix started');
    const { phaseOutcome } = await this.opts.runLoop(ctx);
    if (phaseOutcome === 'passed') {
      this.emit(ctx, 'phase.completed', 'info', 'review-fix converged');
      return { outcome: 'passed' };
    }
    this.emit(ctx, 'phase.failed', 'error', 'review-fix loop exhausted');
    return {
      outcome: 'failed',
      failure: {
        runUuid: ctx.runUuid, phase: 'review-fix', kind: 'validation_failed',
        message: 'review/fix loop exhausted without converging',
        canRetry: true,
        suggestedAction: 'Inspect the latest review.md and loop iterations, then resume or intervene.',
        artifacts: ['review.md'], detectedAt: ctx.now(),
      },
    };
  }

  private emit(ctx: PhaseHandlerContext, type: string, level: 'info' | 'warn' | 'error', message: string): void {
    ctx.events.publish(ctx.runUuid, { runId: ctx.runUuid, phase: 'review-fix', level, type, message, timestamp: ctx.now().toISOString(), metadata: {} });
  }
}
```

- [ ] **Step 4: Run to verify pass.** → PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): review-fix phase handler wrapping M7 loop"`

---

### Task 2: Collapse the timeline / UI phase names

**Files:**
- Modify: `apps/web/src/lib/timeline.ts` (`CANONICAL_PHASES`)
- Modify: `apps/web/src/app/runs/[id]/phase-timeline.tsx` (label map)
- Modify tests: `apps/web/src/lib/__tests__/timeline.test.ts`, `apps/web/e2e/run-detail-timeline.spec.ts`

- [ ] **Step 1: Update the failing test first** — change the expected `CANONICAL_PHASES` in `timeline.test.ts` to replace `'whole-pr-review', 'fix-review'` with a single `'review-fix'` (keep `'fix-validate'`). Run it → FAIL.

```bash
pnpm exec vitest run apps/web/src/lib/__tests__/timeline.test.ts
```

- [ ] **Step 2: Edit `CANONICAL_PHASES`** in `timeline.ts`: replace the two entries with `'review-fix'` in the same position (after `fix-validate`, before `compound`). Update the label map in `phase-timeline.tsx` (e.g. `'review-fix': 'Review / Fix'`); remove the two old labels.

- [ ] **Step 3: Run to verify pass.** `pnpm exec vitest run apps/web/src/lib/__tests__/timeline.test.ts` → PASS. Update `run-detail-timeline.spec.ts` expectations to the unified phase.

- [ ] **Step 4: Commit** `git add -A && git commit -m "refactor(web): collapse whole-pr-review + fix-review into review-fix in timeline"`

---

### Task 3: Reconcile the classifier

**Files:**
- Modify: `packages/infrastructure/src/failure/classifier.ts`
- Modify: `packages/infrastructure/src/failure/__tests__/classifier.test.ts`

- [ ] **Step 1:** Update the classifier tests that reference `fix-review` phase/message to expect `review-fix`. Run → FAIL.
- [ ] **Step 2:** Update `classifier.ts` loop-exhaustion messaging/phase checks (~lines 220/223/252/284) to `review-fix`.
- [ ] **Step 3:** `pnpm exec vitest run packages/infrastructure/src/failure/__tests__/classifier.test.ts` → PASS.
- [ ] **Step 4: Commit** `git add -A && git commit -m "refactor(infra): classifier uses review-fix phase name"`

---

### Task 4: Reconcile result schemas + profile routing per the Task 0 decision

**Files:**
- Modify: `packages/application/src/results/phase-registry.ts` (+ `results/schemas/`)
- Modify: `.ai-orchestrator.json` `agent.phaseProfiles`
- Modify: `packages/shared/src/config/phase-fallbacks.ts` (+ its test)
- Modify: `apps/api/src/compose.ts` if it maps timeline phase → schema/profile

- [ ] **Step 1:** Apply the Task 0 decision matrix. If `review-fix` becomes a registered phase result key, add a `review-fix` entry to `PHASE_RESULT_REGISTRY` (reusing the appropriate schema, likely the loop's terminal verdict schema) and update `results/__tests__/phase-registry.test.ts`. Keep loop-internal routing keys (`whole-pr-fix-review`, `fix-review-architect`) **only if** Task 0 said to.
- [ ] **Step 2:** In `.ai-orchestrator.json`, collapse the timeline-level keys into a single `review-fix` entry (preserve the OpenCode/frontier profile that reviewer-facing output requires — reviewer output is never routed to Pi). Update `phase-fallbacks.ts` accordingly.
- [ ] **Step 3:** Run the affected suites:

```bash
pnpm exec vitest run packages/application/src/results/__tests__/phase-registry.test.ts packages/shared/src/config/__tests__/phase-fallbacks.test.ts apps/api/src/__tests__/compose.test.ts apps/api/src/__tests__/compose-agent.test.ts
```

- [ ] **Step 4: Commit** `git add -A && git commit -m "refactor: reconcile review-fix result schema + profile routing"`

---

### Task 5: DB backfill migration

**Files:**
- Create: `packages/infrastructure/src/sqlite/migrations/0009-review-fix-rename.ts`
- Modify: `packages/infrastructure/src/sqlite/migrations.ts` (register it)
- Test: `packages/infrastructure/src/sqlite/__tests__/migrations.test.ts`

- [ ] **Step 1: Write a migration test** seeding a DB with `whole-pr-review`/`fix-review` rows in the timeline-phase columns and asserting they become `review-fix` after migration. Run → FAIL.
- [ ] **Step 2: Implement `0009-review-fix-rename.ts`** modeled on `0004-phase-rename.ts` (UPDATE `phases.name`, `events.phase`, `artifacts.phase`, `failures.phase`, `runs.current_phase`, and the `runs.completed_phases` JSON REPLACE) from both `whole-pr-review` and `fix-review` → `review-fix`. **Do not** touch `agent_invocations.phase_id` if those keep loop-internal sub-step names (per Task 0). Register `version = 9` in `migrations.ts`.
- [ ] **Step 3:** `pnpm exec vitest run packages/infrastructure/src/sqlite/__tests__/migrations.test.ts` → PASS.
- [ ] **Step 4: Commit** `git add -A && git commit -m "feat(infra): migration 0009 backfill review-fix phase name"`

---

### Task 6: Script phase list + guard test + full sweep

**Files:**
- Modify: `scripts/ai-run-issue-v2`, `scripts/lib/detect-phase.sh` (only the timeline-phase emission, not loop-internal sub-step labels — per Task 0)
- Create: a guard test asserting the legacy timeline names are gone.
- Modify docs: `docs/prd.md` §15.7 note, `docs/design-decisions-report.md` Q26 sample, `README`, `docs/quickstart.md`.

- [ ] **Step 1:** Update the script's emitted timeline phase from the split names to `review-fix` where it represents the timeline phase (verify against `detect-phase.sh` bats tests; update those bats expectations).
- [ ] **Step 2: Add a guard test** (e.g. `packages/application/src/phases/__tests__/no-legacy-review-phase.test.ts`) that reads `apps/web/src/lib/timeline.ts` and asserts `CANONICAL_PHASES` contains `review-fix` and not `whole-pr-review`/`fix-review` as timeline phases. (A repo-wide grep guard is fragile because loop-internal keys legitimately remain; scope the guard to the timeline array.)
- [ ] **Step 3: Full sweep:**

```bash
pnpm -r typecheck && pnpm lint && pnpm test && pnpm test:bash
```
Expected: all PASS.

- [ ] **Step 4: Commit** `git add -A && git commit -m "refactor: complete review-fix rename across scripts + docs + guard"`

---

## Self-review checklist

- [ ] Task 0 decision matrix produced and confirmed before any edit.
- [ ] Acceptance → tests: timeline single `review-fix` (Task 2 + guard Task 6), classifier uses `review-fix` (Task 3), config/schemas reconciled (Task 4), DB backfill (Task 5), handler converges/exhausts (Task 1).
- [ ] `fix-validate` left intact (search the diff to confirm it was not touched).
- [ ] Loop-internal routing keys (`whole-pr-fix-review`, `fix-review-architect`) handled per the confirmed decision — not blindly deleted.
- [ ] All suites green including `pnpm test:bash`.
- [ ] `parity[#339]` updated to assert resume at `review-fix` (not `whole-pr-review`); `parity[#337]/#274/#281/#282/#283` still green.
- [ ] Parity gate (`check-parity-coverage.sh`) satisfied — either an extended/added parity test, or a human `no-parity-impact` note coordinated for the PR body.

## Definition of done

Merged with green CI **including the parity gate**; rename is atomic in one PR; timeline/classifier/UI consistent on the unified `review-fix`; DB migration backfills history; `fix-validate` untouched; the M7 loop drives the handler; the review-fix parity rows pass (with `#339` updated for the new resume target).
