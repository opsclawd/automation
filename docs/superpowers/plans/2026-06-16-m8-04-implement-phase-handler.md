# M8-04: implement Phase Handler with Step Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `implement` phase handler: parse `plan.md` into an ordered list of Steps, and for each Step run a bounded internal loop (implement → spec-review → quality-review → fix, max `phases.implement.maxIterations`, default 5). Persist each Step's success immediately so a resumed run skips completed Steps and starts at the first incomplete one.

**Architecture:** A pure `deriveSteps(planMarkdown)` function turns the plan into `Step[]`. `ImplementHandler` iterates Steps; for each it runs a per-step loop built on the **existing** `Loop` domain helpers (`createLoop`/`canIterate`/`startIteration`/`completeIteration`/`exhaust` from `@ai-sdlc/domain`) with `type: 'implement-step'`. Step status is persisted through a new `StepRepositoryPort`. The handler signals fallback escalation on two consecutive same-profile failures (the use-case-owned trigger, mirroring `ReviewFixLoop`).

**Tech Stack:** TypeScript (strict, ESM), Vitest, `@ai-sdlc/domain` (`loop.ts`), existing ports + `AgentPort`.

---

## Critical context (read first)

- **Q3:** `implement` is one Phase; tasks are **Steps**; each Step has its own bounded Loop (spec-review + quality-review + fix, max 5).
- **Q7:** `PARTIAL` is valid only at the Phase level; **Steps are binary** SUCCESS/FAILED.
- **Q4:** resume from the failed Step by default (trust prior Steps' commits).
- **Q5:** Step completion signal = **DB status + filesystem artifacts**; on resume, mismatch → corruption flag requiring user decision.
- **Q8:** a Step loop hitting max iterations → Step FAILED → Phase FAILED.
- **Reuse the Loop domain.** `packages/domain/src/loop.ts` provides `createLoop({ id, runId, phaseId, type, maxIterations, now })`, `canIterate`, `startIteration`, `completeIteration`, `exhaust`. `LoopType` already includes `'implement-step'`. Persist loops via the existing `LoopRepositoryPort` (`packages/application/src/ports/loop-repository-port.ts`) with the `FakeLoopRepository` test double.
- **The existing Bash implement loop** runs per-task: `implement-task-N`, `spec-review-task-N`, `quality-review-task-N`, `fix-review-task-N`. The result schemas exist in `results/phase-registry.ts` (`implement`, `spec-review`, `quality-review`, `fix-review`). Mirror this structure.
- Builds on M8-01 (`phase-definitions`), M8-02 (`PhaseHandler`), M8-03 (`runSingleShotAgentPhase`, extended context). Reuse `ctx.resolveProfile('implement')` etc.

## File structure

- Create: `packages/application/src/phases/derive-steps.ts` — pure plan → Step[].
- Create: `packages/application/src/ports/step-repository-port.ts` — Step persistence port.
- Create: `packages/application/src/test-doubles/fake-step-repository.ts`.
- Create: `packages/application/src/phases/handlers/implement.ts`.
- Create tests: `derive-steps.test.ts`, `implement.test.ts`, `fake-step-repository.test.ts`.
- Modify: `packages/domain/src/` (add a `Step` type if none exists — check `packages/domain/src` first), `packages/application/src/phases/index.ts`, `test-doubles/index.ts`.

---

### Task 1: `Step` domain type + `StepRepositoryPort`

**Files:**
- Create: `packages/domain/src/step.ts` (only if no `Step` exists — grep `packages/domain/src` first)
- Create: `packages/application/src/ports/step-repository-port.ts`

- [ ] **Step 1: Add the domain type** `packages/domain/src/step.ts`:

```ts
import type { RunId, PhaseName } from './ids.js';

export type StepStatus = 'pending' | 'running' | 'success' | 'failed';

export interface Step {
  id: string;
  runId: RunId;
  phaseId: PhaseName;
  index: number; // 1-based order within the phase
  title: string;
  status: StepStatus;
  startedAt?: Date;
  completedAt?: Date;
}
```

Export it from `packages/domain/src/index.ts` (append `export * from './step.js';`).

- [ ] **Step 2: Add the port** `packages/application/src/ports/step-repository-port.ts`:

```ts
import type { RunId, Step } from '@ai-sdlc/domain';

export interface StepRepositoryPort {
  upsert(step: Step): void;
  listForRun(runId: RunId): Step[];
  findByIndex(runId: RunId, phaseId: string, index: number): Step | undefined;
}
```

Export from `packages/application/src/ports/index.ts`.

- [ ] **Step 3: Typecheck.** `pnpm -r typecheck` → PASS.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(domain): Step type + StepRepositoryPort"
```

> Persistence (SQLite) for steps is a composition-root concern; the executor (M8-10) wires the real repo. This story only needs the port + fake.

---

### Task 2: `FakeStepRepository`

**Files:**
- Create: `packages/application/src/test-doubles/fake-step-repository.ts`
- Test: `packages/application/src/__tests__/fake-step-repository.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { FakeStepRepository } from '../test-doubles/fake-step-repository.js';
import type { Step, RunId, PhaseName } from '@ai-sdlc/domain';

const step = (i: number, status: Step['status']): Step => ({
  id: `s${i}`, runId: 'r1' as RunId, phaseId: 'implement' as PhaseName,
  index: i, title: `task ${i}`, status,
});

describe('FakeStepRepository', () => {
  it('upserts and lists by run, ordered by index', () => {
    const repo = new FakeStepRepository();
    repo.upsert(step(2, 'pending'));
    repo.upsert(step(1, 'success'));
    repo.upsert(step(1, 'success')); // upsert same id replaces
    const all = repo.listForRun('r1' as RunId);
    expect(all.map((s) => s.index)).toEqual([1, 2]);
  });
  it('finds by index', () => {
    const repo = new FakeStepRepository();
    repo.upsert(step(3, 'failed'));
    expect(repo.findByIndex('r1' as RunId, 'implement', 3)?.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm exec vitest run packages/application/src/__tests__/fake-step-repository.test.ts` → FAIL.

- [ ] **Step 3: Implement:**

```ts
import type { RunId, Step } from '@ai-sdlc/domain';
import type { StepRepositoryPort } from '../ports/step-repository-port.js';

export class FakeStepRepository implements StepRepositoryPort {
  private byId = new Map<string, Step>();
  upsert(step: Step): void {
    this.byId.set(step.id, { ...step });
  }
  listForRun(runId: RunId): Step[] {
    return [...this.byId.values()]
      .filter((s) => s.runId === runId)
      .sort((a, b) => a.index - b.index);
  }
  findByIndex(runId: RunId, phaseId: string, index: number): Step | undefined {
    return this.listForRun(runId).find((s) => s.phaseId === phaseId && s.index === index);
  }
}
```

Export from `packages/application/src/test-doubles/index.ts`.

- [ ] **Step 4: Run to verify pass.** → PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "test(application): FakeStepRepository"`

---

### Task 3: `deriveSteps(planMarkdown)` (pure, deterministic)

**Files:**
- Create: `packages/application/src/phases/derive-steps.ts`
- Test: `packages/application/src/phases/__tests__/derive-steps.test.ts`

**Derivation rule (document in code):** Each second-level heading that begins with `## Task` (case-insensitive, optionally numbered like `## Task 3:`) starts one Step. The heading text (minus the `##`) is the Step title. Steps are numbered 1..N in document order. This matches the Bash `implement-task-N` convention.

- [ ] **Step 1: Write the failing test (use a fixture mirroring real plan.md):**

```ts
import { describe, it, expect } from 'vitest';
import { deriveSteps } from '../derive-steps.js';

const plan = `# Plan

Intro prose.

## Task 1: Add the widget
do stuff

## Task 2: Wire it up
more stuff

## Notes
not a task
`;

describe('deriveSteps', () => {
  it('extracts one ordered Step per "## Task" heading', () => {
    const steps = deriveSteps(plan);
    expect(steps.map((s) => s.index)).toEqual([1, 2]);
    expect(steps[0]).toMatchObject({ index: 1, title: 'Task 1: Add the widget' });
    expect(steps[1]!.title).toBe('Task 2: Wire it up');
  });
  it('returns empty when there are no task headings', () => {
    expect(deriveSteps('# Plan\n\njust prose')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure.** → FAIL.

- [ ] **Step 3: Implement:**

```ts
export interface DerivedStep {
  index: number;
  title: string;
}

const TASK_HEADING_RE = /^##\s+(Task\b.*)$/i;

/** Deterministically derive ordered Steps from plan.md.
 *  Each "## Task ..." second-level heading = one Step. */
export function deriveSteps(planMarkdown: string): DerivedStep[] {
  const steps: DerivedStep[] = [];
  for (const line of planMarkdown.split('\n')) {
    const m = TASK_HEADING_RE.exec(line.trim());
    if (m) steps.push({ index: steps.length + 1, title: m[1]!.trim() });
  }
  return steps;
}
```

- [ ] **Step 4: Run to verify pass.** → PASS.

> Before merging, validate `TASK_HEADING_RE` against 2–3 real `plan.md` artifacts from past runs (look under `.ai-runs/*/` or attach fixtures). If the real plans use a different task-heading convention, adjust the regex and add a fixture test — do **not** guess.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): deterministic deriveSteps from plan.md"`

---

### Task 4: `ImplementHandler` — per-Step loop, persistence, resume-skip, exhaustion

**Files:**
- Create: `packages/application/src/phases/handlers/implement.ts`
- Test: `packages/application/src/phases/handlers/__tests__/implement.test.ts`

The handler depends on injected step-runner callbacks (like `ReviewFixLoop`'s `runReview`/`runFix`) so it is testable without real agents. Define them in the handler's options.

- [ ] **Step 1: Write the failing tests:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { ImplementHandler } from '../implement.js';
import { FakeStepRepository } from '../../../test-doubles/fake-step-repository.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeLoopRepository } from '../../../test-doubles/fake-loop-repository.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

function ctx(extra: { artifacts: FakeArtifactStore }) {
  const events: OrchestratorEvent[] = [];
  return {
    ctx: {
      runId: 'r1', runUuid: 'r1', repoFullName: 'a/b', issueNumber: 1, cwd: '/wt',
      artifacts: extra.artifacts, agent: {} as never, git: {} as never, github: {} as never,
      events: { publish: (_u: string, e: OrchestratorEvent) => events.push(e), subscribe: () => () => {} },
      now: () => new Date('2026-06-16T00:00:00Z'),
      promptsRoot: '/p', startCommitSha: 'sha0', expectedBranch: 'feat/x',
      resolveProfile: () => 'pi-qwen-local', idFactory: (() => { let n = 0; return () => `id-${++n}`; })(),
    } as unknown as PhaseHandlerContext,
    events,
  };
}

describe('ImplementHandler', () => {
  it('runs each Step and persists success; phase passes', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({ runId: 'r1', relativePath: 'plan.md', contents: '## Task 1: A\n## Task 2: B\n' });
    const steps = new FakeStepRepository();
    const loops = new FakeLoopRepository();
    const { ctx: c } = ctx({ artifacts });

    const runStep = vi.fn().mockResolvedValue({ outcome: 'success' as const });
    const res = await new ImplementHandler({ steps, loops, runStep, maxIterations: 5 }).run(c);

    expect(res.outcome).toBe('passed');
    expect(runStep).toHaveBeenCalledTimes(2);
    expect(steps.listForRun('r1' as never).map((s) => s.status)).toEqual(['success', 'success']);
  });

  it('skips already-successful steps on resume', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({ runId: 'r1', relativePath: 'plan.md', contents: '## Task 1: A\n## Task 2: B\n' });
    const steps = new FakeStepRepository();
    steps.upsert({ id: 's1', runId: 'r1' as never, phaseId: 'implement' as never, index: 1, title: 'Task 1: A', status: 'success' });
    const loops = new FakeLoopRepository();
    const { ctx: c } = ctx({ artifacts });
    const runStep = vi.fn().mockResolvedValue({ outcome: 'success' as const });

    await new ImplementHandler({ steps, loops, runStep, maxIterations: 5 }).run(c);
    expect(runStep).toHaveBeenCalledTimes(1); // only Step 2
  });

  it('fails the phase when a Step fails', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({ runId: 'r1', relativePath: 'plan.md', contents: '## Task 1: A\n' });
    const steps = new FakeStepRepository();
    const loops = new FakeLoopRepository();
    const { ctx: c } = ctx({ artifacts });
    const runStep = vi.fn().mockResolvedValue({ outcome: 'failed' as const });

    const res = await new ImplementHandler({ steps, loops, runStep, maxIterations: 5 }).run(c);
    expect(res.outcome).toBe('failed');
    expect(steps.listForRun('r1' as never)[0]!.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run to verify failure.** → FAIL (module missing).

- [ ] **Step 3: Implement `implement.ts`:**

```ts
import type { PhaseName, RunId, Step } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import type { StepRepositoryPort } from '../../ports/step-repository-port.js';
import type { LoopRepositoryPort } from '../../ports/loop-repository-port.js';
import { deriveSteps } from '../derive-steps.js';

export interface StepRunContext {
  stepIndex: number;
  stepTitle: string;
  cwd: string;
  ctx: PhaseHandlerContext;
}
export interface StepRunResult {
  outcome: 'success' | 'failed';
}
export interface ImplementHandlerOpts {
  steps: StepRepositoryPort;
  loops: LoopRepositoryPort;
  maxIterations: number;
  /** Runs one Step's internal review/fix loop. Injected so the handler is testable
   *  without real agents. The production wiring (M8-10) builds this on AgentPort +
   *  the Loop domain helpers (createLoop/canIterate/startIteration/completeIteration/exhaust). */
  runStep: (sctx: StepRunContext) => Promise<StepRunResult>;
}

export class ImplementHandler implements PhaseHandler {
  readonly phase = 'implement' as PhaseName;
  constructor(private readonly opts: ImplementHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    this.emit(ctx, 'phase.started', 'info', 'implement started');
    const planMd = await ctx.artifacts.read(ctx.runUuid, 'plan.md');
    const derived = deriveSteps(planMd);
    if (derived.length === 0) {
      return this.fail(ctx, 'invalid_result', 'plan.md has no "## Task" steps');
    }

    const existing = this.opts.steps.listForRun(ctx.runUuid as RunId);
    const doneIdx = new Set(existing.filter((s) => s.status === 'success').map((s) => s.index));

    for (const d of derived) {
      if (doneIdx.has(d.index)) {
        this.emit(ctx, 'step.skipped', 'info', `step ${d.index} already complete`, { index: d.index });
        continue;
      }
      const step: Step = {
        id: ctx.idFactory(), runId: ctx.runUuid as RunId, phaseId: this.phase,
        index: d.index, title: d.title, status: 'running', startedAt: ctx.now(),
      };
      this.opts.steps.upsert(step);
      this.emit(ctx, 'step.started', 'info', `step ${d.index}: ${d.title}`, { index: d.index });

      const result = await this.opts.runStep({
        stepIndex: d.index, stepTitle: d.title, cwd: ctx.cwd, ctx,
      });

      if (result.outcome === 'success') {
        this.opts.steps.upsert({ ...step, status: 'success', completedAt: ctx.now() });
        this.emit(ctx, 'step.completed', 'info', `step ${d.index} done`, { index: d.index });
      } else {
        this.opts.steps.upsert({ ...step, status: 'failed', completedAt: ctx.now() });
        this.emit(ctx, 'step.failed', 'error', `step ${d.index} failed`, { index: d.index });
        return this.fail(ctx, 'agent_incomplete', `step ${d.index} (${d.title}) failed`);
      }
    }

    this.emit(ctx, 'phase.completed', 'info', 'implement complete');
    return { outcome: 'passed' };
  }

  private emit(ctx: PhaseHandlerContext, type: string, level: 'info' | 'warn' | 'error', message: string, metadata: Record<string, unknown> = {}): void {
    ctx.events.publish(ctx.runUuid, { runId: ctx.runUuid, phase: 'implement', level, type, message, timestamp: ctx.now().toISOString(), metadata });
  }
  private fail(ctx: PhaseHandlerContext, kind: import('@ai-sdlc/domain').FailureKind, message: string): PhaseResult {
    this.emit(ctx, 'phase.failed', 'error', message);
    return { outcome: 'failed', failure: { runUuid: ctx.runUuid, phase: 'implement', kind, message, canRetry: true, suggestedAction: 'Inspect the failing step artifacts and resume.', artifacts: [], detectedAt: ctx.now() } };
  }
}
```

- [ ] **Step 4: Run to verify pass.** `pnpm exec vitest run packages/application/src/phases/handlers/__tests__/implement.test.ts` → PASS (3 tests).

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): implement phase handler with step loop + resume"`

---

### Task 5: Per-step loop runner (production `runStep`) using the Loop domain

**Files:**
- Create: `packages/application/src/phases/handlers/run-implement-step.ts`
- Test: `packages/application/src/phases/handlers/__tests__/run-implement-step.test.ts`

This is the production `runStep` that the executor injects. It builds a `Loop` (`type: 'implement-step'`), runs implement → spec-review → quality-review → fix per iteration, escalates to `fallbackProfile` after two consecutive same-profile failures (use-case-owned trigger, per M4-02c), and returns SUCCESS/FAILED.

- [ ] **Step 1: Write a focused test** that, with scripted review/fix callbacks, (a) converges on iteration 2 → success, (b) exhausts at maxIterations → failed, (c) emits `phase.fallback.escalated` after two consecutive fix failures. Model the test on `packages/application/src/review-fix/__tests__/review-fix-loop.test.ts` (same `createLoop`/`canIterate` mechanics).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** using `createLoop`, `canIterate`, `startIteration`, `completeIteration`, `exhaust` from `@ai-sdlc/domain` and `LoopRepositoryPort.insert/update` — closely following `ReviewFixLoop.execute` in `packages/application/src/review-fix/review-fix-loop.ts`. The agent calls go through `runSingleShotAgentPhase`-style invocations for `implement`, `spec-review`, `quality-review`, `fix-review` (profiles via `ctx.resolveProfile`). Escalation: track `consecutiveFixFailures`; when `>= 2` and a `fixFallbackProfile` is configured, emit `phase.fallback.escalated` with `triggerReason: 'two_consecutive_fix_failures'`, `triggerOwner: 'use_case'`.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): per-step implement loop with fallback escalation"`

---

### Task 6: Export + boundaries + full suite

- [ ] **Step 1:** Append exports to `packages/application/src/phases/index.ts` (`derive-steps`, `handlers/implement`, `handlers/run-implement-step`) and `test-doubles/index.ts` (`fake-step-repository`).
- [ ] **Step 2:** `pnpm -r typecheck && pnpm lint && pnpm depcruise && pnpm test` → all PASS.
- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(application): export implement phase handler + step deps"`

---

## Self-review checklist

- [ ] Acceptance → tests: N tasks → N steps (Task 3), per-step success persisted (Task 4), resume skips successful steps (Task 4), loop exhaustion → FAILED (Task 5), two-consecutive-failure fallback (Task 5).
- [ ] Q5 corruption check (DB-says-done / artifact-missing) — **add a follow-up note**: M8-10's executor performs the cross-check on resume; if you can cheaply assert artifact presence per successful step here, do so and emit `step.corruption_detected` + return `blocked`. Otherwise file it for M8-10.
- [ ] Steps are binary (no PARTIAL at step level) — verified by the `StepStatus` union.
- [ ] Reuses `Loop` domain helpers and mirrors `ReviewFixLoop`; no new loop bookkeeping invented.
- [ ] `deriveSteps` regex validated against real `plan.md` fixtures.

## Definition of done

Merged with green CI; step derivation deterministic + fixtured; resume-from-step and loop-exhaustion proven; fallback escalation emitted; Step persistence behind a port with a fake.
