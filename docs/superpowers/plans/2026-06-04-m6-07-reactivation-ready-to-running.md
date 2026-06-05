# M6-07 — Reactivation: READY → RUNNING on New Review Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make READY a resting-but-not-terminal state. When the managed poller resolves all comments, the Run transitions to READY (`status: 'waiting'`). A reactivation check detects **new** review activity after READY and transitions the Run back to RUNNING to process it; if the global `readyMaxDays` deadline passes first, the Run is CANCELLED.

**Architecture:** A pure `ReactivateOnReview` use case in `packages/application/src/pr-review/` decides, given the Run, the last-seen activity cursor, and the current review comments, whether to **reactivate**, **stay ready**, or **time out**. It uses the existing domain transitions `transitionToReady` / `reactivate` / `cancelRun` (already in `packages/domain/src/run.ts`; `waiting` is the READY status). The poller (M6-04) calls it after reaching `all_resolved`. No infra imports.

**Tech Stack:** TypeScript 5 strict, Vitest.

**Depends on:** M6-04 (poller), M6-01 (repo), M3-01 (`Run` transitions: `transitionToReady`, `reactivate`, `cancelRun`, status `waiting`).

**Key domain facts (verified in `packages/domain/src/run.ts`):**
- `transitionToReady(run)` requires `currentPhase` unset and `status === 'running'`; sets `status: 'waiting'`.
- `reactivate(run)` requires `status === 'waiting'`; sets `status: 'running'`.
- `cancelRun(run, reason, at)` sets `status: 'cancelled'` (terminal).

---

### Task 1: `ReactivateOnReview` decision use case

**Files:**
- Create: `packages/application/src/pr-review/reactivate-on-review.ts`
- Modify: `packages/application/src/index.ts`
- Test: `packages/application/src/pr-review/__tests__/reactivate-on-review.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/application/src/pr-review/__tests__/reactivate-on-review.test.ts
import { describe, it, expect } from 'vitest';
import { decideReactivation } from '../reactivate-on-review.js';

const readyAt = new Date('2026-06-04T00:00:00Z');

describe('decideReactivation', () => {
  it('stays ready when there is no new activity before the deadline', () => {
    const d = decideReactivation({
      readyAt,
      now: new Date('2026-06-05T00:00:00Z'),
      readyMaxDays: 7,
      lastSeenActivityAt: readyAt,
      newestCommentAt: readyAt, // nothing newer
    });
    expect(d.action).toBe('stay_ready');
  });

  it('reactivates when a comment arrives after the last-seen cursor', () => {
    const d = decideReactivation({
      readyAt,
      now: new Date('2026-06-04T06:00:00Z'),
      readyMaxDays: 7,
      lastSeenActivityAt: readyAt,
      newestCommentAt: new Date('2026-06-04T05:00:00Z'), // newer than cursor
    });
    expect(d.action).toBe('reactivate');
  });

  it('times out when the deadline passes with no new activity', () => {
    const d = decideReactivation({
      readyAt,
      now: new Date('2026-06-12T00:00:01Z'), // > 7 days after readyAt
      readyMaxDays: 7,
      lastSeenActivityAt: readyAt,
      newestCommentAt: readyAt,
    });
    expect(d.action).toBe('timeout');
  });

  it('prefers reactivation over timeout when both new activity and deadline coincide', () => {
    const d = decideReactivation({
      readyAt,
      now: new Date('2026-06-12T00:00:01Z'),
      readyMaxDays: 7,
      lastSeenActivityAt: readyAt,
      newestCommentAt: new Date('2026-06-11T00:00:00Z'),
    });
    expect(d.action).toBe('reactivate');
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/application test -- reactivate-on-review`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the pure decision function**

```typescript
// packages/application/src/pr-review/reactivate-on-review.ts
export interface ReactivationDecisionInput {
  readyAt: Date;
  now: Date;
  readyMaxDays: number;
  /** Cursor: the newest review activity already processed before READY. */
  lastSeenActivityAt: Date;
  /** Timestamp of the newest review comment currently on the PR (or readyAt if none). */
  newestCommentAt: Date;
}

export type ReactivationAction = 'reactivate' | 'stay_ready' | 'timeout';

export interface ReactivationDecision {
  action: ReactivationAction;
  reason: string;
}

/**
 * Pure policy: given a READY run and the latest review activity, decide
 * whether to reactivate, keep resting, or time out.
 *
 * New activity ALWAYS wins over the deadline — a reviewer who comments at the
 * last moment should not be dropped on the floor.
 */
export function decideReactivation(input: ReactivationDecisionInput): ReactivationDecision {
  const hasNewActivity = input.newestCommentAt.getTime() > input.lastSeenActivityAt.getTime();
  if (hasNewActivity) {
    return { action: 'reactivate', reason: 'new review activity since READY' };
  }
  const deadlineMs = input.readyAt.getTime() + input.readyMaxDays * 24 * 60 * 60 * 1000;
  if (input.now.getTime() > deadlineMs) {
    return { action: 'timeout', reason: `readyMaxDays (${input.readyMaxDays}) exceeded` };
  }
  return { action: 'stay_ready', reason: 'no new activity, within deadline' };
}
```

- [ ] **Step 4: Export from the application barrel**

In `packages/application/src/index.ts`, add:

```typescript
export * from './pr-review/reactivate-on-review.js';
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/application test -- reactivate-on-review && pnpm --filter @ai-sdlc/application typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/application/src/pr-review/reactivate-on-review.ts packages/application/src/index.ts packages/application/src/pr-review/__tests__/reactivate-on-review.test.ts
git commit -m "feat(application): decideReactivation policy for READY runs (M6-07)"
```

---

### Task 2: Run transitions on resolve / reactivate / timeout

**Files:**
- Create: `packages/application/src/pr-review/apply-reactivation.ts`
- Modify: `packages/application/src/index.ts`
- Test: `packages/application/src/pr-review/__tests__/apply-reactivation.test.ts`

**Why:** Wire the decision to actual `Run` state transitions + persistence + events, kept separate from the pure policy so it stays testable with a fake repository.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/application/src/pr-review/__tests__/apply-reactivation.test.ts
import { describe, it, expect } from 'vitest';
import { createRun, transitionToReady, RunId } from '@ai-sdlc/domain';
import { applyReactivation, type ApplyReactivationDeps } from '../apply-reactivation.js';

function readyRun() {
  // createRun(...) → start running → clear currentPhase → transitionToReady.
  // Build a run already in 'waiting' for the test.
  const run = createRun({
    uuid: '77777777-7777-7777-7777-777777777777',
    displayId: 'issue-7-20260604-000000',
    issueNumber: 7,
    type: 'issue_to_pr',
    startedAt: new Date('2026-06-04T00:00:00Z'),
  } as never);
  // Drive to waiting via the real transition path used in production:
  const running = { ...run, status: 'running' as const, currentPhase: undefined };
  return transitionToReady(running);
}

function makeDeps(saved: { run?: unknown } = {}): ApplyReactivationDeps {
  return {
    runRepository: {
      save: (r: unknown) => { saved.run = r; },
    } as never,
    eventBus: { publish: () => {} } as never,
    now: () => new Date('2026-06-04T06:00:00Z'),
  };
}

describe('applyReactivation', () => {
  it('reactivate -> run becomes running and is saved', () => {
    const saved: { run?: { status: string } } = {};
    const out = applyReactivation(readyRun(), { action: 'reactivate', reason: 'new activity' }, makeDeps(saved));
    expect(out.status).toBe('running');
    expect(saved.run?.status).toBe('running');
  });

  it('timeout -> run becomes cancelled', () => {
    const saved: { run?: { status: string } } = {};
    const out = applyReactivation(readyRun(), { action: 'timeout', reason: 'deadline' }, makeDeps(saved));
    expect(out.status).toBe('cancelled');
    expect(saved.run?.status).toBe('cancelled');
  });

  it('stay_ready -> run unchanged, not saved', () => {
    const saved: { run?: unknown } = {};
    const before = readyRun();
    const out = applyReactivation(before, { action: 'stay_ready', reason: 'resting' }, makeDeps(saved));
    expect(out.status).toBe('waiting');
    expect(saved.run).toBeUndefined();
  });
});
```

> **Implementer note:** Adapt the `createRun(...)` shape to the real signature in `packages/domain/src/run.ts` (see `run.test.ts` for the exact `CreateRunInput`). The `as never` casts are placeholders to be removed once the real shapes are wired.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/application test -- apply-reactivation`
Expected: FAIL.

- [ ] **Step 3: Implement the applier**

```typescript
// packages/application/src/pr-review/apply-reactivation.ts
import { reactivate, cancelRun, type Run } from '@ai-sdlc/domain';
import type { RunRepositoryPort } from '../ports.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { ReactivationDecision } from './reactivate-on-review.js';

export interface ApplyReactivationDeps {
  runRepository: RunRepositoryPort;
  eventBus: EventBusPort;
  now: () => Date;
}

/**
 * Applies a reactivation decision to a READY (status 'waiting') run.
 * Returns the resulting Run. Only persists/emits on an actual transition.
 */
export function applyReactivation(
  run: Run,
  decision: ReactivationDecision,
  deps: ApplyReactivationDeps,
): Run {
  switch (decision.action) {
    case 'reactivate': {
      const next = reactivate(run);
      deps.runRepository.save(next);
      deps.eventBus.publish({
        runId: run.uuid,
        phase: 'post-pr-review',
        level: 'info',
        type: 'post-pr-review.run.reactivated',
        message: decision.reason,
        timestamp: deps.now().toISOString(),
        metadata: { reason: decision.reason },
      } as never);
      return next;
    }
    case 'timeout': {
      const next = cancelRun(run, decision.reason, deps.now());
      deps.runRepository.save(next);
      deps.eventBus.publish({
        runId: run.uuid,
        phase: 'post-pr-review',
        level: 'warn',
        type: 'post-pr-review.run.timed_out',
        message: decision.reason,
        timestamp: deps.now().toISOString(),
        metadata: { reason: decision.reason },
      } as never);
      return next;
    }
    case 'stay_ready':
    default:
      return run;
  }
}
```

> **Implementer notes:**
> - Confirm `RunRepositoryPort` has a `save(run: Run): void` method (the M3/M5 repository port). If the persistence method is named differently (e.g. `update`), use that.
> - Match the real `EventBusPort.publish` event shape and drop the `as never` casts (same as M6-04 Task 1).
> - `run.uuid` is the Run's identity field per `apps/web/src/lib/api-client.ts` (`RunDto.uuid`); confirm the domain field name in `run.ts` and use it.

- [ ] **Step 4: Export from the application barrel**

In `packages/application/src/index.ts`, add:

```typescript
export * from './pr-review/apply-reactivation.js';
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/application test -- apply-reactivation && pnpm --filter @ai-sdlc/application typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/application/src/pr-review/apply-reactivation.ts packages/application/src/index.ts packages/application/src/pr-review/__tests__/apply-reactivation.test.ts
git commit -m "feat(application): applyReactivation transitions READY runs (M6-07)"
```

---

### Task 3: Poller transitions to READY and runs the reactivation loop

**Files:**
- Modify: `packages/application/src/pr-review/pr-review-poller.ts`
- Test: extend `packages/application/src/pr-review/__tests__/pr-review-poller.test.ts`

**Why:** Close the loop — when the poll reaches `all_resolved`, the run should enter READY, and the poller should keep checking for new activity until reactivation or the global deadline. Keep the existing terminal-state return; add the READY behaviour behind an injected hook so existing tests stay valid.

- [ ] **Step 1: Write the failing test**

```typescript
describe('PrReviewPoller — READY + reactivation', () => {
  it('after all_resolved, reactivates and resumes when new activity is detected', async () => {
    // First pass resolves; reactivation check returns 'reactivate' once, then 'stay_ready' (we stop the test there).
    const decisions = ['reactivate', 'stay_ready'] as const;
    let di = 0;
    const { poller } = makePoller([resolved(), resolved()], {
      onAllResolved: async () => {
        const action = decisions[Math.min(di++, decisions.length - 1)];
        return action; // 'reactivate' | 'stay_ready' | 'timeout'
      },
      maxReactivations: 1,
    });
    const result = await poller.run({ runId, repoId, repoFullName: 'o/r', prNumber: 5, cwd: '/w', phaseId: PhaseName('post-pr-review') });
    // After reactivation, the second resolved pass runs; final state is ready.
    expect(result.terminalState).toBe('all_resolved');
    expect(di).toBeGreaterThanOrEqual(1);
  });

  it('cancels the run when reactivation check returns timeout', async () => {
    const { poller } = makePoller([resolved()], {
      onAllResolved: async () => 'timeout',
      maxReactivations: 1,
    });
    const result = await poller.run({ runId, repoId, repoFullName: 'o/r', prNumber: 5, cwd: '/w', phaseId: PhaseName('post-pr-review') });
    expect(result.terminalState).toBe('cancelled');
  });
});
```

> Update the `makePoller` helper in this test file to thread the optional `onAllResolved` and `maxReactivations` into `PrReviewPollerDeps`. Default `onAllResolved` to `async () => 'stay_ready'` so the existing Task-1 tests still terminate at `all_resolved`.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/application test -- pr-review-poller`
Expected: FAIL — `onAllResolved`/`maxReactivations` not in deps; `cancelled` terminal not produced.

- [ ] **Step 3: Extend the poller**

Add to `PrReviewPollerDeps`:

```typescript
  /** Called when a poll resolves all comments. Returns the reactivation action.
   *  Defaults to staying ready (handled by the caller's wiring). */
  onAllResolved?: () => Promise<'reactivate' | 'stay_ready' | 'timeout'>;
  /** Bound on reactivation cycles to keep the loop finite. */
  maxReactivations?: number;
```

Extend `PollerTerminalState`:

```typescript
export type PollerTerminalState =
  | 'all_resolved'
  | 'max_polls_reached'
  | 'blocked'
  | 'timed_out'
  | 'cancelled';
```

Replace the `if (pass.allResolved) { return ... }` block with a READY/reactivation loop:

```typescript
if (pass.allResolved) {
  const check = this.deps.onAllResolved;
  const maxReact = this.deps.maxReactivations ?? 0;
  let reactivations = 0;
  // Enter READY and keep checking for new activity.
  // The caller (compose wiring) is responsible for the actual Run transition
  // via applyReactivation; here we only react to its returned action.
  // eslint-disable-next-line no-constant-condition
  while (check && reactivations < maxReact) {
    const action = await check();
    this.emit(`post-pr-review.ready.${action}`, input, { reactivations });
    if (action === 'timeout') {
      return { terminalState: 'cancelled', pollsRun };
    }
    if (action === 'stay_ready') {
      return { terminalState: 'all_resolved', pollsRun };
    }
    // reactivate: run another pass.
    reactivations++;
    const again = await d.processOnePass({ ...input, pollNumber: d.maxPolls + reactivations });
    pollsRun++;
    if (!again.allResolved) {
      // New unresolved work; fall back into normal completion semantics.
      return { terminalState: 'max_polls_reached', pollsRun };
    }
  }
  return { terminalState: 'all_resolved', pollsRun };
}
```

- [ ] **Step 4: Run to verify pass (incl. existing poller tests)**

Run: `pnpm --filter @ai-sdlc/application test -- pr-review-poller`
Expected: PASS — Task-1/2/3 tests from M6-04 still green (default `onAllResolved` undefined → returns `all_resolved` immediately).

- [ ] **Step 5: Commit**

```bash
git add packages/application/src/pr-review/pr-review-poller.ts packages/application/src/pr-review/__tests__/pr-review-poller.test.ts
git commit -m "feat(application): poller enters READY and honours reactivation/timeout (M6-07)"
```

---

### Task 4: Wire reactivation into the composition root

**Files:**
- Modify: `apps/api/src/compose.ts` (the `buildPrReviewPoller` factory from M6-04)

- [ ] **Step 1: Provide `onAllResolved` from real adapters**

In `buildPrReviewPoller`, construct the `onAllResolved` callback that: reads the Run, computes `newestCommentAt` from `github.listReviewComments`, computes `lastSeenActivityAt` from the latest processed comment / poll cursor, calls `decideReactivation`, then `applyReactivation` (which performs the Run transition + event), and returns the action.

```typescript
import { decideReactivation, applyReactivation } from '@ai-sdlc/application';

// inside buildPrReviewPoller, when assembling PrReviewPoller deps:
onAllResolved: async () => {
  const run = runRepository.findByUuid(/* the run uuid for this poll */ runUuidForPoll);
  if (!run || run.status !== 'waiting') return 'stay_ready';
  const comments = await github.listReviewComments(repoFullNameForPoll, prNumberForPoll);
  const reviewerComments = comments.filter((c) => c.inReplyToId === undefined);
  const newestCommentAt = reviewerComments.reduce(
    (max, c) => (c.createdAt > max ? c.createdAt : max),
    run.completedAt ?? new Date(0),
  );
  const lastSeen = prReviewRepository.latestPollAttempt(run.id)?.completedAt ?? run.startedAt;
  const decision = decideReactivation({
    readyAt: run.completedAt ?? new Date(),
    now: new Date(),
    readyMaxDays: 7,
    lastSeenActivityAt: lastSeen,
    newestCommentAt,
  });
  applyReactivation(run, decision, { runRepository, eventBus, now: () => new Date() });
  return decision.action;
},
maxReactivations: 100,
```

> **Implementer notes:**
> - The factory needs the run uuid / repo full name / PR number in scope. Thread them through `buildPrReviewPoller(opts)` (extend its options) or capture them in the `run-pr-poll.ts` call site. Match whatever the M6-04 factory shape established.
> - Before transitioning to READY, the production flow must first call `transitionToReady(run)` when the phase completes (currentPhase cleared). That happens in the phase-completion path; ensure the run is in `waiting` before `onAllResolved` fires, else it returns `stay_ready`.
> - Confirm domain field names: `run.id` vs `run.uuid`, `run.completedAt`. Use the real ones from `run.ts`.

- [ ] **Step 2: Typecheck + compose test green**

Run: `pnpm --filter @ai-sdlc/api typecheck && pnpm --filter @ai-sdlc/api test -- compose`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/compose.ts
git commit -m "feat(api): wire reactivation/timeout into managed poller (M6-07)"
```

---

### Task 5: Final verification

- [ ] **Step 1: Whole workspace green**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test`
Expected: all green.

- [ ] **Step 2: Domain-purity check**

Run: `grep -rEn "child_process|better-sqlite3|node:fs|execa" packages/application/src/pr-review/`
Expected: no matches.

---

## Self-review notes

- **Story coverage (Q17/Q33):** READY is `status: 'waiting'` (resting, non-terminal). New review activity → `reactivate` (waiting→running). Global `readyMaxDays` deadline with no new activity → `cancelRun` (waiting→cancelled). New activity always beats the deadline.
- **Pure policy / impure applier split:** `decideReactivation` is a pure function (trivially testable); `applyReactivation` performs the domain transition + persistence + events; the poller orchestrates. This keeps each unit independently testable with fakes.
- **Uses existing domain transitions:** No new Run states invented — reuses `transitionToReady`, `reactivate`, `cancelRun` already shipped in `run.ts`.
- **Finiteness:** `maxReactivations` bounds the loop so a pathological reviewer cannot spin it forever within a single process; the global timeout is the ultimate stop.
- **Boundary with M6-04:** M6-04 returns terminal states for a single bounded poll; M6-07 adds the READY resting loop on top. Existing M6-04 tests remain valid because `onAllResolved` defaults to absent → immediate `all_resolved`.
