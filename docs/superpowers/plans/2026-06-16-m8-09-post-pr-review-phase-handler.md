# M8-09: post-pr-review Phase Handler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the post-PR review phase handler that enqueues/runs the managed poll job, drives the Run into READY when all reviews are addressed, reactivates into RUNNING on new review activity, completes on merge, and cancels on the global READY timeout.

**Architecture:** A thin `PostPrReviewHandler` that drives the **existing** managed poller (`PrReviewPoller`) and reactivation helpers (`decideReactivation`/`applyReactivation`) and maps their signals to Run state transitions via the domain `Run` state machine (`transitionToReady`/`reactivate`/`cancel` from `@ai-sdlc/domain`). No polling/comment-processing logic is reimplemented.

**Tech Stack:** TypeScript (strict, ESM), Vitest, `@ai-sdlc/domain` Run transitions, existing PR-review application code.

---

## ⚠️ Phase name reality

The shipped phase name is **`post-pr-review`** (see migration `0004-phase-rename.ts` which mapped `pr-review-poll → post-pr-review`, and `results/phase-registry.ts` key `post-pr-review`). The issue title says `pr-review-poll`; **use `post-pr-review`** to match the codebase. Register the handler under `post-pr-review`.

## Critical context (read first)

- **Q17:** post-PR review is the **same Run extended** (not a new Run). After `create-pr`, the Run enters `post-pr-review`. Run completes only on PR merge or cancel.
- **Q33:** terminal/resting states beyond RUNNING: **READY** (all reviews addressed, *not* terminal — reactivates on new activity), **SUCCESS** (PR merged, terminal), **CANCELLED** (timeout or user cancel, terminal). Global `timeouts.readyMaxDays` (default 7) applies to READY.
- **Reuse existing code** (all imported in `apps/api/src/compose.ts`): `PrReviewPoller`, `ProcessPrReviewComments`, `decideReactivation`, `applyReactivation`, `pollTaskResultSchema`. Comment processing/verification is M6 — do not reimplement.
- Domain `Run` transitions (`packages/domain/src/run.ts`): use the existing `transitionToReady`/`reactivate`/`cancel` (verify exact names in that file). The handler updates run state via `RunRepositoryPort.update(...)` (see `ports.ts` `RunRepositoryUpdatePatch` with `status`).
- The poll job rides the shared `JobQueuePort` + repo lease (M3) so it cannot race an issue Run on the same repo — that wiring is the executor's (M8-10); this handler enqueues/drives.
- Builds on M8-02 `PhaseHandler`. Phase output artifacts: `comments.json`, `reviews.json` (written by the M6 poller).

## File structure

- Create: `packages/application/src/phases/handlers/post-pr-review.ts`
- Create: `packages/application/src/phases/handlers/__tests__/post-pr-review.test.ts`
- Modify: `packages/application/src/phases/index.ts`

---

### Task 1: All-resolved → READY

**Files:**
- Create: `packages/application/src/phases/handlers/post-pr-review.ts`
- Test: `packages/application/src/phases/handlers/__tests__/post-pr-review.test.ts`

The handler takes injected callbacks so it is testable without the real poller: `runPoll()` returns a terminal signal (`'all_resolved' | 'merged' | 'pending'`), and a `setRunStatus(status)` to record the transition.

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { PostPrReviewHandler } from '../post-pr-review.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

function ctx() {
  const events: OrchestratorEvent[] = [];
  return {
    ctx: {
      runId: 'r1', runUuid: 'r1', repoFullName: 'a/b', issueNumber: 1, cwd: '/wt',
      artifacts: {} as never, agent: {} as never, git: {} as never, github: {} as never,
      events: { publish: (_u: string, e: OrchestratorEvent) => events.push(e), subscribe: () => () => {} },
      now: () => new Date('2026-06-16T00:00:00Z'),
    } as unknown as PhaseHandlerContext,
    events,
  };
}

describe('PostPrReviewHandler', () => {
  it('transitions the Run to READY when the poller reports all_resolved', async () => {
    const setRunStatus = vi.fn();
    const handler = new PostPrReviewHandler({
      runPoll: async () => ({ signal: 'all_resolved' as const }),
      setRunStatus,
      readyMaxDays: 7,
    });
    const { ctx: c, events } = ctx();
    const res = await handler.run(c);
    expect(res.outcome).toBe('passed'); // phase handed off to resting state
    expect(setRunStatus).toHaveBeenCalledWith('waiting'); // READY maps to the domain 'waiting' status — verify in run.ts
    expect(events.some((e) => e.type === 'run.ready')).toBe(true);
  });
});
```

> **Verify the READY status string** in `packages/domain/src/run.ts` (`RunStatus` union). The PRD §15.1 union is `queued|running|waiting|passed|failed|cancelled|blocked|needs_human_review`; READY likely maps to `'waiting'`. Use the real value.

- [ ] **Step 2: Run to verify failure.** → FAIL.

- [ ] **Step 3: Implement `post-pr-review.ts`:**

```ts
import type { PhaseName, RunStatus } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';

export type PollSignal = 'all_resolved' | 'merged' | 'pending';

export interface PostPrReviewHandlerOpts {
  /** Runs one cycle of the managed poller (M6 PrReviewPoller) and returns a terminal signal. */
  runPoll: (ctx: PhaseHandlerContext) => Promise<{ signal: PollSignal }>;
  /** Persists the Run status transition (wired to RunRepositoryPort.update by the executor). */
  setRunStatus: (status: RunStatus) => void;
  readyMaxDays: number;
}

export class PostPrReviewHandler implements PhaseHandler {
  readonly phase = 'post-pr-review' as PhaseName;
  constructor(private readonly opts: PostPrReviewHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    this.emit(ctx, 'phase.started', 'info', 'post-pr-review started');
    const { signal } = await this.opts.runPoll(ctx);

    if (signal === 'merged') {
      this.opts.setRunStatus('passed');
      this.emit(ctx, 'run.completed', 'info', 'PR merged — run complete');
      return { outcome: 'passed' };
    }

    if (signal === 'all_resolved') {
      this.opts.setRunStatus('waiting'); // READY (resting, non-terminal)
      this.emit(ctx, 'run.ready', 'info', 'all reviews addressed — awaiting merge');
      return { outcome: 'passed' };
    }

    // pending: leave RUNNING; the managed poller schedules the next cycle.
    this.emit(ctx, 'post-pr-review.poll.pending', 'info', 'reviews still pending');
    return { outcome: 'passed' };
  }

  private emit(ctx: PhaseHandlerContext, type: string, level: 'info' | 'warn' | 'error', message: string): void {
    ctx.events.publish(ctx.runUuid, { runId: ctx.runUuid, phase: 'post-pr-review', level, type, message, timestamp: ctx.now().toISOString(), metadata: {} });
  }
}
```

- [ ] **Step 4: Run to verify pass.** → PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): post-pr-review handler — all_resolved → READY"`

---

### Task 2: Merged → SUCCESS

- [ ] **Step 1: Add test:**

```ts
it('transitions to SUCCESS (passed) when the PR is merged', async () => {
  const setRunStatus = vi.fn();
  const handler = new PostPrReviewHandler({ runPoll: async () => ({ signal: 'merged' as const }), setRunStatus, readyMaxDays: 7 });
  const { ctx: c } = ctx();
  await handler.run(c);
  expect(setRunStatus).toHaveBeenCalledWith('passed');
});
```

- [ ] **Step 2: Run** → PASS (logic already present).
- [ ] **Step 3: Commit** `git add -A && git commit -m "test(application): post-pr-review merged → SUCCESS"`

---

### Task 3: Reactivation + READY timeout

Reactivation (READY → RUNNING on new activity) and the READY-timeout (→ CANCELLED) are driven by the managed poller cycle, not a single phase invocation. Wire these via the existing `decideReactivation`/`applyReactivation` helpers.

- [ ] **Step 1: Add a reactivation test** using `decideReactivation` semantics: given a READY run and new review activity, the decision is to reactivate; assert the handler/poller calls `setRunStatus('running')` and emits `run.reactivated`. (Model the test on the existing reactivation tests — grep `decideReactivation` usage in `packages/application` for the input shape.)

- [ ] **Step 2: Add a timeout test** using an injected clock: when `now - readyAt > readyMaxDays`, the poller cycle calls `setRunStatus('cancelled')` and emits `run.cancelled_timeout`.

- [ ] **Step 3: Implement** the reactivation + timeout branch. If these naturally belong in the M6 `PrReviewPoller` rather than the handler, place them there and have the handler/executor consult them — document the chosen location. Do not duplicate reactivation logic that already exists.

- [ ] **Step 4: Run** the new tests → PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): post-pr-review reactivation + READY timeout"`

---

### Task 4: Export + boundaries + full suite

- [ ] **Step 1:** Append `export * from './handlers/post-pr-review.js';` to `phases/index.ts`.
- [ ] **Step 2:** `pnpm -r typecheck && pnpm lint && pnpm depcruise && pnpm test` → all PASS.
- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(application): export post-pr-review handler"`

---

## Self-review checklist

- [ ] Phase registered as `post-pr-review` (not `pr-review-poll`).
- [ ] Acceptance → tests: all_resolved → READY (Task 1), merged → SUCCESS (Task 2), reactivation → RUNNING + timeout → CANCELLED (Task 3).
- [ ] Reuses `PrReviewPoller`/`decideReactivation`/`applyReactivation`; no reimplementation of polling or comment processing.
- [ ] READY status string verified against `RunStatus` in `run.ts`.
- [ ] Names consistent: `PostPrReviewHandler`, `PostPrReviewHandlerOpts`, `PollSignal`.

## Definition of done

Merged with green CI; READY/reactivation/merge/timeout transitions proven; polling rides the managed job; no `nohup` background process.
