# M7-02: ReviewFixLoop Use Case — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a runtime-agnostic `ReviewFixLoop` application use case that drives review → fix → revalidate → re-review until the review passes or the iteration budget is exhausted, persisting a `Loop` + iterations and escalating to a fallback profile on documented triggers.

**Architecture:** The loop is **pure orchestration** over three injected step collaborators (`runReview`, `runFix`, `runRevalidation`) plus the `LoopRepositoryPort` and `EventBusPort`. The collaborators hide the messy mechanics (calling `AgentPort` through the router, reading the verdict deterministically via M4-05 `extractResult`, linking the new `AgentInvocation` id, running validation). This keeps the loop trivially unit-testable with fakes and concentrates infra wiring in the composition root. The loop never names `opencode`/`pi` and imports no infrastructure.

**Tech Stack:** TypeScript (strict), Vitest. Depends on **#335 (M7-01)**, M4-02 (router), M4-05 (`extractResult`), M5-02 (validation). GitHub issue: **#336**.

---

## Background the engineer must know

- **Why collaborators, not direct `AgentPort`:** `AgentPort.invoke(...)` (`packages/application/src/ports/agent-port.ts`) returns an `AgentInvocationResult` that has **no invocation id** — the `AgentRuntimeRouter` generates the id internally and inserts the `agent_invocations` row. The loop needs ids for `LoopIteration.reviewInvocationId` / `fixInvocationId` (used by the M7-04 UI). Rather than scrape the invocation repo from inside the loop (fragile; the `FakeAgentPort` doesn't even insert rows), we inject step functions that return `{ invocationId, ... }`. The composition root implements them by wrapping the router and diffing the invocation repo once, centrally.
- **The review verdict is NOT `all_resolved`.** The milestone doc says `outcome === 'all_resolved'`; the **actual** shipped schemas (`packages/application/src/results/schemas/`) are:
  - `whole-pr-review` → `{ result: 'pass' | 'fail', findings: [...] }` → **loop converges when `result === 'pass'`.**
  - `fix-review` → `{ result: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix' }` → `cannot_fix` is a fix failure.
  Read both files before coding. Use these exact strings.
- **Deterministic result reading (M4-05):** verdicts come from `extractResult` (`packages/application/src/results/extract-result.ts`) parsing `result.json` against the phase Zod schema in `PHASE_RESULT_REGISTRY` (`packages/application/src/results/phase-registry.ts`). **No log scraping. No extra LLM calls in the hot path.**
- **Q8 (design-decisions-report):** loop exhaustion → enclosing phase FAILED.
- **Fallback ownership (M4-02c):** the router auto-handles *adapter-level* triggers (timeout, missing artifact, invalid result.json, budget, contract violation) — the loop does nothing for those. The loop OWNS *use-case-level* triggers and signals them by requesting the fallback profile. This plan implements two: **(a) two consecutive fix failures on the loop**, **(b) the revalidation failure category changes between iterations**.
- **Event shape** (`packages/shared/src/events/schema.ts`): `{ runId, phase?, level, type, message, timestamp(ISO string), metadata }`. Emit via `eventBus.publish(runUuid, event)`. Copy the call style from `packages/application/src/pr-review/apply-reactivation.ts`.
- **Container/compose root:** `apps/api/src/compose.ts` exposes `agentRuntime` (the router, an `AgentPort`), `agentInvocationRepository`, `runValidation`, `eventBus`, `runsDir`, plus the artifact store. You will add `loopRepository` and `reviewFixLoop` here.
- **Run all commands from repo root** `/home/gary/.openclaw/workspace/automation`.

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/application/src/review-fix/types.ts` (create) | Step-collaborator interfaces + loop input/output/deps types. |
| `packages/application/src/review-fix/review-fix-loop.ts` (create) | `ReviewFixLoop` — pure orchestration. |
| `packages/application/src/review-fix/__tests__/review-fix-loop.test.ts` (create) | Orchestration unit tests (fake collaborators). |
| `packages/application/src/review-fix/read-verdicts.ts` (create) | `readReviewVerdict` / `readFixVerdict` helpers over `extractResult`. |
| `packages/application/src/review-fix/__tests__/read-verdicts.test.ts` (create) | Deterministic-extraction tests. |
| `packages/application/src/index.ts` (modify) | Export the use case + types. |
| `apps/api/src/compose.ts` (modify) | Build `loopRepository`, the 3 collaborators, and `reviewFixLoop`; expose on the Container. |
| `apps/api/src/__tests__/compose.test.ts` (modify) | Assert the Container exposes `reviewFixLoop`. |

---

## Task 1: Loop step-collaborator types

**Files:**
- Create: `packages/application/src/review-fix/types.ts`

- [ ] **Step 1: Write the types**

Create `packages/application/src/review-fix/types.ts`:

```ts
import type { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { Loop } from '@ai-sdlc/domain';
import type { LoopRepositoryPort } from '../ports/loop-repository-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';

/** Outcome of the underlying agent process, mirrors AgentInvocationResult.outcome. */
export type StepAgentOutcome = 'success' | 'failed' | 'timeout' | 'contract_violation';

/** Per-call context handed to each step collaborator. */
export interface StepContext {
  loopId: string;
  runId: RunId;
  phaseId: PhaseName;
  repoId: string;
  cwd: string;
  iterationIndex: number; // 1-based
}

export interface ReviewStepResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  /** Present only when result.json parsed cleanly. */
  verdict?: 'pass' | 'fail';
}

export interface FixStepResult {
  invocationId: string;
  agentOutcome: StepAgentOutcome;
  verdict?: 'done_with_fixes' | 'done_no_fixes_needed' | 'cannot_fix';
}

export interface RevalidationResult {
  validationRunId: string;
  passed: boolean;
  /** Coarse failure category for category-change detection (e.g. 'build'|'lint'|'typecheck'|'test'). */
  category?: string;
}

export interface FixStepOptions {
  /** When true, the collaborator must run the fix on the fallback profile and
   *  link the new AgentInvocation to `previousInvocationId` via fallbackOfInvocationId. */
  useFallback: boolean;
  previousInvocationId?: string;
}

export interface ReviewFixLoopDeps {
  runReview: (ctx: StepContext) => Promise<ReviewStepResult>;
  runFix: (ctx: StepContext, opts: FixStepOptions) => Promise<FixStepResult>;
  runRevalidation: (ctx: StepContext) => Promise<RevalidationResult>;
  loops: LoopRepositoryPort;
  events: EventBusPort;
  now: () => Date;
  idFactory: () => string;
}

export interface ReviewFixLoopInput {
  runId: RunId;
  phaseId: PhaseName; // whole-pr-review / fix-review today
  repoId: string;
  cwd: string;
  maxIterations: number; // from phases.reviewFix.maxIterations
  reviewProfile: AgentProfileName; // for escalation-event metadata
  fixProfile: AgentProfileName;
  fixFallbackProfile?: AgentProfileName;
}

export interface ReviewFixLoopResult {
  loop: Loop;
  phaseOutcome: 'passed' | 'failed';
}
```

- [ ] **Step 2: Build**

Run: `pnpm --filter @ai-sdlc/application build`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/application/src/review-fix/types.ts
git commit -m "feat(application): ReviewFixLoop step-collaborator types (M7-02, #336)"
```

---

## Task 2: ReviewFixLoop orchestration

**Files:**
- Create: `packages/application/src/review-fix/review-fix-loop.ts`
- Test: `packages/application/src/review-fix/__tests__/review-fix-loop.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/application/src/review-fix/__tests__/review-fix-loop.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import { FakeLoopRepository } from '../../test-doubles/fake-loop-repository.js';
import { ReviewFixLoop } from '../review-fix-loop.js';
import type {
  ReviewFixLoopDeps,
  ReviewStepResult,
  FixStepResult,
  RevalidationResult,
  FixStepOptions,
  StepContext,
} from '../types.js';

function collectEvents() {
  const events: Array<{ type: string; metadata: Record<string, unknown> }> = [];
  const bus = {
    publish: (_runUuid: string, e: OrchestratorEvent) =>
      events.push({ type: e.type, metadata: e.metadata }),
    subscribe: () => () => {},
  };
  return { events, bus };
}

function baseInput() {
  return {
    runId: RunId('run-1'),
    phaseId: PhaseName('whole-pr-review'),
    repoId: 'owner/repo',
    cwd: '/wt',
    maxIterations: 3,
    reviewProfile: AgentProfileName('opencode-frontier'),
    fixProfile: AgentProfileName('pi-qwen-local'),
    fixFallbackProfile: AgentProfileName('opencode-frontier'),
  };
}

function makeDeps(over: Partial<ReviewFixLoopDeps>): ReviewFixLoopDeps {
  let n = 0;
  const { bus } = collectEvents();
  return {
    runReview: async (): Promise<ReviewStepResult> => ({
      invocationId: `rev-${++n}`,
      agentOutcome: 'success',
      verdict: 'pass',
    }),
    runFix: async (): Promise<FixStepResult> => ({
      invocationId: `fix-${++n}`,
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
    }),
    runRevalidation: async (): Promise<RevalidationResult> => ({
      validationRunId: `val-${++n}`,
      passed: true,
    }),
    loops: new FakeLoopRepository(),
    events: bus,
    now: () => new Date('2026-06-14T00:00:00.000Z'),
    idFactory: () => 'loop-1',
    ...over,
  };
}

describe('ReviewFixLoop', () => {
  it('converges on iteration 1 when review passes immediately', async () => {
    const deps = makeDeps({});
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.status).toBe('converged');
    expect(out.loop.iterations).toHaveLength(1);
    expect(out.loop.iterations[0]?.outcome).toBe('resolved');
  });

  it('converges on iteration 2 (fail → fix → pass)', async () => {
    let reviewCalls = 0;
    const deps = makeDeps({
      runReview: async () => {
        reviewCalls += 1;
        return {
          invocationId: `rev-${reviewCalls}`,
          agentOutcome: 'success' as const,
          verdict: reviewCalls === 1 ? ('fail' as const) : ('pass' as const),
        };
      },
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('passed');
    expect(out.loop.iterations).toHaveLength(2);
    expect(out.loop.iterations[0]?.outcome).toBe('fixed');
    expect(out.loop.iterations[1]?.outcome).toBe('resolved');
    expect(reviewCalls).toBe(2); // re-review is the next iteration's review — no double invoke
  });

  it('exhausts and fails when review never passes', async () => {
    const { events, bus } = collectEvents();
    const deps = makeDeps({
      events: bus,
      runReview: async () => ({ invocationId: 'r', agentOutcome: 'success', verdict: 'fail' }),
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('failed');
    expect(out.loop.status).toBe('exhausted');
    expect(out.loop.iterations).toHaveLength(3);
    expect(events.filter((e) => e.type === 'loop.exhausted')).toHaveLength(1);
  });

  it('hard-fails when the review agent itself fails', async () => {
    const deps = makeDeps({
      runReview: async () => ({ invocationId: 'r', agentOutcome: 'failed' }),
    });
    const out = await new ReviewFixLoop(deps).execute(baseInput());
    expect(out.phaseOutcome).toBe('failed');
    expect(out.loop.status).toBe('failed');
    expect(out.loop.iterations[0]?.outcome).toBe('failed');
  });

  it('escalates to the fallback profile after two consecutive fix failures', async () => {
    const { events, bus } = collectEvents();
    const fixCalls: FixStepOptions[] = [];
    const deps = makeDeps({
      events: bus,
      runReview: async () => ({ invocationId: 'r', agentOutcome: 'success', verdict: 'fail' }),
      runFix: async (_ctx: StepContext, opts: FixStepOptions) => {
        fixCalls.push(opts);
        return { invocationId: `fix-${fixCalls.length}`, agentOutcome: 'failed' as const };
      },
    });
    await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });

    // Iterations 1 & 2 fix on the primary profile; iteration 3 escalates.
    expect(fixCalls[0]?.useFallback).toBe(false);
    expect(fixCalls[1]?.useFallback).toBe(false);
    expect(fixCalls[2]?.useFallback).toBe(true);
    expect(fixCalls[2]?.previousInvocationId).toBe('fix-2');
    const esc = events.filter((e) => e.type === 'phase.fallback.escalated');
    expect(esc).toHaveLength(1);
    expect(esc[0]?.metadata.triggerOwner).toBe('use_case');
    expect(esc[0]?.metadata.triggerReason).toBe('two_consecutive_fix_failures');
  });

  it('escalates when the revalidation failure category changes between iterations', async () => {
    const { events, bus } = collectEvents();
    const cats = ['build', 'test']; // category changes on the 2nd failing revalidation
    let revalCall = 0;
    const fixCalls: FixStepOptions[] = [];
    const deps = makeDeps({
      events: bus,
      runReview: async () => ({ invocationId: 'r', agentOutcome: 'success', verdict: 'fail' }),
      runFix: async (_c, opts) => {
        fixCalls.push(opts);
        return { invocationId: `fix-${fixCalls.length}`, agentOutcome: 'success', verdict: 'done_with_fixes' };
      },
      runRevalidation: async () => ({
        validationRunId: `v${revalCall}`,
        passed: false,
        category: cats[revalCall++] ?? 'test',
      }),
    });
    await new ReviewFixLoop(deps).execute({ ...baseInput(), maxIterations: 3 });
    // iteration 2's fix should be requested with fallback because category went build→test.
    expect(fixCalls[1]?.useFallback).toBe(true);
    expect(events.some((e) => e.type === 'phase.fallback.escalated' && e.metadata.triggerReason === 'validation_category_changed')).toBe(true);
  });

  it('emits iteration started/completed events per iteration', async () => {
    const { events, bus } = collectEvents();
    const deps = makeDeps({ events: bus });
    await new ReviewFixLoop(deps).execute(baseInput());
    expect(events.filter((e) => e.type === 'loop.iteration.started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'loop.iteration.completed')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ai-sdlc/application test -- review-fix-loop.test.ts`
Expected: FAIL — `Cannot find module '../review-fix-loop.js'`.

- [ ] **Step 3: Write the use case**

Create `packages/application/src/review-fix/review-fix-loop.ts`:

```ts
import {
  createLoop,
  startIteration,
  completeIteration,
  canIterate,
  exhaust,
  type Loop,
  type AgentProfileName,
} from '@ai-sdlc/domain';
import type { OrchestratorEvent } from '@ai-sdlc/shared';
import type {
  ReviewFixLoopDeps,
  ReviewFixLoopInput,
  ReviewFixLoopResult,
  StepContext,
} from './types.js';

export class ReviewFixLoop {
  constructor(private readonly deps: ReviewFixLoopDeps) {}

  async execute(input: ReviewFixLoopInput): Promise<ReviewFixLoopResult> {
    const { deps } = this;
    let loop = createLoop({
      id: deps.idFactory(),
      runId: input.runId,
      phaseId: input.phaseId,
      type: 'review-fix',
      maxIterations: input.maxIterations,
      now: deps.now(),
    });
    deps.loops.insert(loop);

    let consecutiveFixFailures = 0;
    let lastFixInvocationId: string | undefined;
    let lastFailingCategory: string | undefined;

    while (canIterate(loop)) {
      const iterationIndex = loop.iterations.length + 1;
      const ctx: StepContext = {
        loopId: loop.id,
        runId: input.runId,
        phaseId: input.phaseId,
        repoId: input.repoId,
        cwd: input.cwd,
        iterationIndex,
      };

      // --- REVIEW ---
      const review = await deps.runReview(ctx);
      loop = startIteration(loop, { reviewInvocationId: review.invocationId, now: deps.now() });
      deps.loops.update(loop);
      this.emit(input, 'loop.iteration.started', 'info', `review/fix iteration ${iterationIndex} started`, {
        index: iterationIndex,
      });

      if (review.agentOutcome !== 'success' || review.verdict === undefined) {
        loop = completeIteration(loop, { outcome: 'failed', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'failed');
        break; // loop.status === 'failed'
      }

      if (review.verdict === 'pass') {
        loop = completeIteration(loop, { outcome: 'resolved', now: deps.now() });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'resolved');
        break; // converged
      }

      // --- decide fallback (use-case-owned triggers) ---
      const escalateForFixFailures = consecutiveFixFailures >= 2;
      const useFallback = (escalateForFixFailures) && input.fixFallbackProfile !== undefined;
      if (useFallback) {
        this.emitEscalation(input, 'two_consecutive_fix_failures');
      }

      // --- FIX ---
      const fix = await deps.runFix(ctx, {
        useFallback,
        ...(lastFixInvocationId !== undefined ? { previousInvocationId: lastFixInvocationId } : {}),
      });
      lastFixInvocationId = fix.invocationId;

      if (fix.agentOutcome !== 'success' || fix.verdict === 'cannot_fix') {
        consecutiveFixFailures += 1;
        loop = completeIteration(loop, {
          outcome: 'unresolved',
          fixInvocationId: fix.invocationId,
          now: deps.now(),
        });
        deps.loops.update(loop);
        this.emitIterationCompleted(input, iterationIndex, 'unresolved');
        continue;
      }
      consecutiveFixFailures = 0;

      // --- REVALIDATE ---
      const reval = await deps.runRevalidation(ctx);

      // category-change trigger: if this revalidation failed with a different
      // category than the previous failing one, escalate the NEXT fix.
      if (!reval.passed && reval.category !== undefined) {
        if (lastFailingCategory !== undefined && lastFailingCategory !== reval.category) {
          if (input.fixFallbackProfile !== undefined) {
            // Force escalation on next iteration's fix by tripping the counter.
            consecutiveFixFailures = 2;
            this.emitEscalation(input, 'validation_category_changed');
          }
        }
        lastFailingCategory = reval.category;
      }

      loop = completeIteration(loop, {
        outcome: reval.passed ? 'fixed' : 'unresolved',
        fixInvocationId: fix.invocationId,
        revalidationId: reval.validationRunId,
        now: deps.now(),
      });
      deps.loops.update(loop);
      this.emitIterationCompleted(input, iterationIndex, reval.passed ? 'fixed' : 'unresolved');
      // next iteration re-reviews
    }

    if (loop.status === 'converged') {
      return { loop, phaseOutcome: 'passed' };
    }
    if (loop.status === 'failed') {
      return { loop, phaseOutcome: 'failed' };
    }
    // ran out of budget without converging
    loop = exhaust(loop, this.deps.now());
    this.deps.loops.update(loop);
    this.emit(input, 'loop.exhausted', 'error', `review/fix loop exhausted after ${loop.iterations.length} iterations`, {
      iterations: loop.iterations.length,
      maxIterations: loop.maxIterations,
    });
    return { loop, phaseOutcome: 'failed' };
  }

  private emit(
    input: ReviewFixLoopInput,
    type: string,
    level: OrchestratorEvent['level'],
    message: string,
    metadata: Record<string, unknown>,
  ): void {
    this.deps.events.publish(input.runId as unknown as string, {
      runId: input.runId as unknown as string,
      phase: input.phaseId as unknown as string,
      level,
      type,
      message,
      timestamp: this.deps.now().toISOString(),
      metadata,
    });
  }

  private emitIterationCompleted(input: ReviewFixLoopInput, index: number, outcome: string): void {
    this.emit(input, 'loop.iteration.completed', 'info', `iteration ${index} completed: ${outcome}`, {
      index,
      outcome,
    });
  }

  private emitEscalation(input: ReviewFixLoopInput, triggerReason: string): void {
    const toProfile = input.fixFallbackProfile as AgentProfileName;
    this.emit(input, 'phase.fallback.escalated', 'warn', `escalating fix to ${toProfile}`, {
      fromProfile: input.fixProfile as unknown as string,
      toProfile: toProfile as unknown as string,
      triggerReason,
      triggerOwner: 'use_case',
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @ai-sdlc/application test -- review-fix-loop.test.ts`
Expected: PASS. If the category-change test fails, re-check that `consecutiveFixFailures = 2` is set *before* the next loop turn and that the escalation event fires on the category change itself.

- [ ] **Step 5: Export from the application index**

Edit `packages/application/src/index.ts` — add:

```ts
export * from './review-fix/types.js';
export * from './review-fix/review-fix-loop.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/application/src/review-fix/ packages/application/src/index.ts
git commit -m "feat(application): ReviewFixLoop orchestration (M7-02, #336)"
```

---

## Task 3: Deterministic verdict-reading helpers

These convert an `AgentInvocation` + its `AgentInvocationResult` into a typed verdict using M4-05 `extractResult`. They are used by the composition-root collaborators (Task 4). Keeping them in `packages/application` lets us unit-test deterministic extraction without infra.

**Files:**
- Create: `packages/application/src/review-fix/read-verdicts.ts`
- Test: `packages/application/src/review-fix/__tests__/read-verdicts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/application/src/review-fix/__tests__/read-verdicts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PhaseName, RunId, AgentProfileName, AgentInvocationId } from '@ai-sdlc/domain';
import type { AgentInvocation } from '@ai-sdlc/domain';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { FakeAgentPort } from '../../test-doubles/fake-agent-port.js';
import { readReviewVerdict, readFixVerdict } from '../read-verdicts.js';

function invocation(phase: string, resultJsonPath?: string): AgentInvocation {
  return {
    id: AgentInvocationId('inv-1'),
    runId: RunId('run-1'),
    phaseId: PhaseName(phase),
    profile: AgentProfileName('opencode-frontier'),
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'claude-opus-4.7',
    promptPath: '/wt/prompt.md',
    promptChars: 10,
    stdoutPath: '/wt/out.log',
    stderrPath: '/wt/err.log',
    startedAt: new Date('2026-06-14T00:00:00.000Z'),
    startCommitSha: 'abc',
    timeoutMs: 60000,
    contractViolations: [],
    ...(resultJsonPath ? { resultJsonPath } : {}),
  } as AgentInvocation;
}

describe('readReviewVerdict', () => {
  it("returns 'pass' for a valid whole-pr-review result.json", async () => {
    const artifacts = new FakeArtifactStore();
    artifacts.seed('run-1', 'result.json', JSON.stringify({ result: 'pass', findings: [] }));
    const agent = new FakeAgentPort();
    const v = await readReviewVerdict(invocation('whole-pr-review', 'result.json'), { artifacts, agent });
    expect(v).toEqual({ ok: true, verdict: 'pass' });
  });

  it('returns not-ok when result.json is missing (no LLM fallback)', async () => {
    const artifacts = new FakeArtifactStore();
    const agent = new FakeAgentPort(); // no scripted responses → throws if invoked
    const v = await readReviewVerdict(invocation('whole-pr-review', undefined), { artifacts, agent });
    expect(v.ok).toBe(false);
    // FakeAgentPort throws "No scripted response" if extractResult tried an LLM call.
    expect(agent.invocations).toHaveLength(0);
  });
});

describe('readFixVerdict', () => {
  it('maps fix-review result strings', async () => {
    const artifacts = new FakeArtifactStore();
    artifacts.seed('run-1', 'result.json', JSON.stringify({ result: 'done_with_fixes' }));
    const agent = new FakeAgentPort();
    const v = await readFixVerdict(invocation('fix-review', 'result.json'), { artifacts, agent });
    expect(v).toEqual({ ok: true, verdict: 'done_with_fixes' });
  });
});
```

> NOTE: verify the `FakeArtifactStore` seeding API (method name may be `seed`/`write`/`set`) by reading `packages/application/src/test-doubles/fake-artifact-store.ts`, and confirm `extractResult`'s `read(runId, path)` signature matches. Adjust the seed calls to match the real fake.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ai-sdlc/application test -- read-verdicts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helpers**

Create `packages/application/src/review-fix/read-verdicts.ts`:

```ts
import type { AgentInvocation } from '@ai-sdlc/domain';
import { extractResult } from '../results/extract-result.js';
import type { ArtifactStore, AgentPort } from '../ports.js';
import type { WholePrReviewResult } from '../results/schemas/whole-pr-review.js';
import type { FixReviewResult } from '../results/schemas/fix-review.js';

export type VerdictOutcome<V> = { ok: true; verdict: V } | { ok: false; detail: string };

/**
 * Reads the review verdict deterministically from result.json.
 * Does NOT pass `rerunContext`, so extractResult never issues an LLM rerun here —
 * the loop handles iteration explicitly. No log scraping.
 */
export async function readReviewVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; agent: AgentPort },
): Promise<VerdictOutcome<'pass' | 'fail'>> {
  const r = await extractResult({ invocation, ports });
  if (!r.ok) return { ok: false, detail: r.detail };
  return { ok: true, verdict: (r.result as WholePrReviewResult).result };
}

export async function readFixVerdict(
  invocation: AgentInvocation,
  ports: { artifacts: ArtifactStore; agent: AgentPort },
): Promise<VerdictOutcome<FixReviewResult['result']>> {
  const r = await extractResult({ invocation, ports });
  if (!r.ok) return { ok: false, detail: r.detail };
  return { ok: true, verdict: (r.result as FixReviewResult).result };
}
```

> Confirm `WholePrReviewResult` / `FixReviewResult` are exported from their schema files (they are: `export type ... = z.infer<...>`). If not exported from a barrel, import directly from the schema paths shown.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @ai-sdlc/application test -- read-verdicts.test.ts`
Expected: PASS, and `agent.invocations` is empty (proves no LLM call in the hot path).

- [ ] **Step 5: Commit**

```bash
git add packages/application/src/review-fix/read-verdicts.ts packages/application/src/review-fix/__tests__/read-verdicts.test.ts
git commit -m "feat(application): deterministic review/fix verdict readers (M7-02, #336)"
```

---

## Task 4: Wire the collaborators + ReviewFixLoop into the composition root

This is the infra-facing glue: it builds the three step collaborators from the existing container parts (router, invocation repo, artifact store, runValidation) and constructs `reviewFixLoop`.

**Files:**
- Modify: `apps/api/src/compose.ts`
- Test: `apps/api/src/__tests__/compose.test.ts`

- [ ] **Step 1: Add a failing assertion to the compose test**

In `apps/api/src/__tests__/compose.test.ts`, add (mirroring how existing members like `runValidation` are asserted):

```ts
it('exposes reviewFixLoop and loopRepository', () => {
  const c = composeRoot({ repoRoot, scriptPath: '/dev/null', runStartupSweeps: false });
  expect(c.loopRepository).toBeDefined();
  expect(c.reviewFixLoop).toBeDefined();
});
```

> Reuse the existing `repoRoot` / temp-dir setup already present in that test file.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ai-sdlc/api test -- compose.test.ts`
Expected: FAIL — `c.reviewFixLoop` is undefined.

- [ ] **Step 3: Build the loop repository, collaborators, and use case in `compose.ts`**

In `apps/api/src/compose.ts`:

1. Import the new pieces near the other infra/application imports:
   ```ts
   import { LoopRepository } from '@ai-sdlc/infrastructure';
   import { ReviewFixLoop, readReviewVerdict, readFixVerdict } from '@ai-sdlc/application';
   import { RunId, PhaseName, AgentProfileName } from '@ai-sdlc/domain';
   ```
   (Confirm `LoopRepository` is exported from `@ai-sdlc/infrastructure` — add `export * from './sqlite/loop-repository.js';` to `packages/infrastructure/src/index.ts` if missing.)

2. After `const agentInvocationRepository = new AgentInvocationRepository(db);` add:
   ```ts
   const loopRepository = new LoopRepository(db);
   ```

3. Build the collaborators *only when the agent runtime is configured* (guard like the existing `agentRuntime` block). Place this after `agentRuntime` is constructed:

   ```ts
   let reviewFixLoop: ReviewFixLoop | undefined;
   if (agentRuntime) {
     const router = agentRuntime; // AgentPort

     // Returns the id of the newest invocation for the run (the one the router
     // just inserted). Serial loop ⇒ race-free.
     const newestInvocationId = (runUuid: string): string => {
       const list = agentInvocationRepository.listByRun(RunId(runUuid));
       const last = list[list.length - 1];
       return last ? (last.id as unknown as string) : '';
     };

     const runReview = async (ctx: import('@ai-sdlc/application').StepContext) => {
       const result = await router.invoke({
         profile: AgentProfileName(reviewProfileName),
         promptPath: reviewPromptPath(ctx),
         expectedArtifacts: ['result.json'],
         cwd: ctx.cwd,
         runId: ctx.runId as unknown as string,
         repoId: ctx.repoId,
         phaseId: 'whole-pr-review',
         startCommitSha: headSha(ctx.cwd),
       });
       const invocationId = newestInvocationId(ctx.runId as unknown as string);
       const inv = agentInvocationRepository.findById(/* AgentInvocationId */ invocationId as never);
       const verdict = inv
         ? await readReviewVerdict(inv, { artifacts: artifactStore, agent: router })
         : { ok: false as const, detail: 'no invocation row' };
       return {
         invocationId,
         agentOutcome: result.outcome,
         ...(verdict.ok ? { verdict: verdict.verdict } : {}),
       };
     };

     // runFix and runRevalidation follow the same shape; runFix honours
     // opts.useFallback by selecting fixFallbackProfileName and passing
     // fallbackOfInvocationId: opts.previousInvocationId. runRevalidation calls
     // runValidation.execute(...) and maps the first failing command's `kind`
     // to `category`.
     // ... (see notes below) ...

     reviewFixLoop = new ReviewFixLoop({
       runReview,
       runFix,
       runRevalidation,
       loops: loopRepository,
       events: eventBus,
       now: () => new Date(),
       idFactory: () => randomUUID(),
     });
   }
   ```

   **Notes for the engineer (resolve against the real file):**
   - `reviewProfileName` / `fixProfileName` / `fixFallbackProfileName` come from the loaded config’s `agent.phaseProfiles` (`whole-pr-review` and `fix-review` entries). Reuse the same resolution logic `run-agent.ts` uses (`resolveProfileName` / `config.agent.phaseProfiles`). If a helper isn’t exported, read the entries directly: `config.agent.phaseProfiles['whole-pr-review'].profile`, etc.
   - `reviewPromptPath(ctx)` / fix prompt path: reuse the existing prompt locations the Bash review/fix phases already use (the prompt files under `prompts/`). For M7-02, a constant path per phase is acceptable; M7-03 passes real prompt paths from Bash.
   - `headSha(cwd)`: get current commit via the existing `GitPort`/git adapter in the container, or a small `git rev-parse HEAD` helper already present in infra. Do not introduce a new git dependency — reuse what compose already wires.
   - `runRevalidation` maps `runValidation.execute({ runId, phaseId: PhaseName('validate'), cwd, logDir, commands, timeoutSeconds })` → `{ validationRunId: validationRun.id, passed, category: firstFailingKind }`. Read `config.validation.commands` / `config.validation.timeout` exactly as `run-validation.ts` does.

4. Add `loopRepository` and `reviewFixLoop?: ReviewFixLoop` to the `Container` type and the returned object (mirror how `runValidation` / `agentInvocationRepository` are declared and returned).

- [ ] **Step 4: Run the compose test**

Run: `pnpm --filter @ai-sdlc/api test -- compose.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/compose.ts apps/api/src/__tests__/compose.test.ts packages/infrastructure/src/index.ts
git commit -m "feat(api): wire ReviewFixLoop + collaborators into composition root (M7-02, #336)"
```

---

## Task 5: Full verification

- [ ] **Step 1: Build, test, lint everything**

Run: `pnpm -r build && pnpm -r test && pnpm -r lint`
Expected: all green.

- [ ] **Step 2: Prove the loop imports no infrastructure / runtime**

Run: `grep -nE "child_process|opencode|pi-adapter|better-sqlite3|node:fs|from '@ai-sdlc/infrastructure'" packages/application/src/review-fix/*.ts`
Expected: no matches (the loop + helpers are pure application code).

- [ ] **Step 3: Confirm no LLM call inside extraction hot path**

Run: `grep -n "agent.invoke\|\.invoke(" packages/application/src/review-fix/read-verdicts.ts`
Expected: no matches (extraction reads files only; reruns are not requested here).

---

## Self-Review checklist (run before handoff)

- [ ] Issue #336 acceptance mapped: convergence (T2 test) ✔; exhaustion→FAILED + `loop.exhausted` event (T2) ✔; no-double-invoke (T2, `reviewCalls===2`) ✔; deterministic result reading / no LLM in hot path (T3 + T5 grep) ✔; use-case fallback w/ `triggerOwner:'use_case'` + `previousInvocationId` (T2) ✔; no-fallback config surfaces failure (covered: without `fixFallbackProfile`, `useFallback` stays false and the loop exhausts/fails) ✔; agent rows carry profile/runtime/model (router responsibility, exercised via collaborators) ✔; purity grep (T5) ✔.
- [ ] Verdict strings match the real schemas: review `'pass'|'fail'`, fix `'done_with_fixes'|'done_no_fixes_needed'|'cannot_fix'`.
- [ ] Type names consistent: `ReviewFixLoop`, `ReviewFixLoopDeps`, `StepContext`, `ReviewStepResult`, `FixStepResult`, `RevalidationResult`, `FixStepOptions`, `readReviewVerdict`, `readFixVerdict`, `loopRepository`, `reviewFixLoop`.
- [ ] No placeholders in committed code. (The compose-root `runFix`/`runRevalidation` bodies must be fully written before Task 4 commit — the "...notes..." in this plan are instructions, not code to paste.)
- [ ] Events emitted: `loop.iteration.started`, `loop.iteration.completed`, `loop.exhausted`, `phase.fallback.escalated`.
```
