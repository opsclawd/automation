# M6-04 — Managed PR-Review Poller (in-process scheduler) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unmanaged `nohup` background PR poller with a durable, observable in-process scheduler that drives `ProcessPrReviewComments` (M6-03) on an interval, persists each `PollAttempt`, computes the next poll time, emits `post-pr-review.poll.*` events, backs off on rate-limit, and terminates on `all_resolved` / max polls / global timeout.

**Architecture:** A `PrReviewPoller` class in `packages/application/src/pr-review/`. It owns the loop; one iteration calls the injected single-pass processor. Time and sleeping are injected (`now()`, `sleep(ms)`) so tests run instantly with a fake clock. State persists via `PrReviewRepositoryPort` (M6-01). No infra imports. Per the M6 scope decision this is an **in-process scheduler keyed off `poll_attempts`** — it is *not* the SQLite `JobQueuePort`/`WorkerLeasePort` (those remain M8). Reactivation after READY is M6-07; this story stops at the first terminal state.

**Tech Stack:** TypeScript 5 strict, Vitest.

**Depends on:** M6-03 (`ProcessPrReviewComments`), M6-01 (repo + `PollAttempt`).

**Prior art:** the poll loop in `scripts/ai-pr-review-poll` (max-polls bound, `POLL_INTERVAL` sleep, terminal classification ALL_DONE/PARTIAL/BLOCKED, rate-limit backoff).

---

### Task 1: Poller types + happy-path termination on all-resolved

**Files:**
- Create: `packages/application/src/pr-review/pr-review-poller.ts`
- Modify: `packages/application/src/index.ts`
- Test: `packages/application/src/pr-review/__tests__/pr-review-poller.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/application/src/pr-review/__tests__/pr-review-poller.test.ts
import { describe, it, expect } from 'vitest';
import { RunId, RepositoryId, PhaseName } from '@ai-sdlc/domain';
import { FakePrReviewRepository } from '../../test-doubles/index.js';
import { PrReviewPoller, type PrReviewPollerDeps, type PollPassResult } from '../pr-review-poller.js';

const runId = RunId('55555555-5555-5555-5555-555555555555');
const repoId = RepositoryId('o/r');

function makePoller(passes: PollPassResult[], over: Partial<PrReviewPollerDeps> = {}) {
  const repo = new FakePrReviewRepository();
  const events: Array<{ type: string; metadata: unknown }> = [];
  let i = 0;
  const sleeps: number[] = [];
  let clock = new Date('2026-06-04T00:00:00Z');

  const deps: PrReviewPollerDeps = {
    prReviewRepo: repo,
    processOnePass: async () => passes[Math.min(i++, passes.length - 1)],
    eventBus: { publish: (e: { type: string; metadata?: unknown }) => events.push({ type: e.type, metadata: e.metadata }) } as never,
    sleep: async (ms: number) => { sleeps.push(ms); clock = new Date(clock.getTime() + ms); },
    now: () => clock,
    maxPolls: 3,
    pollIntervalMs: 1000,
    readyMaxDays: 7,
    ...over,
  };
  return { poller: new PrReviewPoller(deps), repo, events, sleeps };
}

const resolved = (): PollPassResult => ({ outcome: 'ALL_DONE', processed: 1, blocked: 0, allResolved: true, rateLimited: false });
const partial = (): PollPassResult => ({ outcome: 'PARTIAL', processed: 0, blocked: 0, allResolved: false, rateLimited: false });

describe('PrReviewPoller', () => {
  it('stops at the first all-resolved pass', async () => {
    const { poller, events } = makePoller([resolved()]);
    const result = await poller.run({ runId, repoId, repoFullName: 'o/r', prNumber: 5, cwd: '/w', phaseId: PhaseName('post-pr-review') });
    expect(result.terminalState).toBe('all_resolved');
    expect(result.pollsRun).toBe(1);
    expect(events.map((e) => e.type)).toContain('post-pr-review.poll.completed');
  });

  it('runs up to maxPolls then terminates as max_polls_reached', async () => {
    const { poller } = makePoller([partial(), partial(), partial()]);
    const result = await poller.run({ runId, repoId, repoFullName: 'o/r', prNumber: 5, cwd: '/w', phaseId: PhaseName('post-pr-review') });
    expect(result.pollsRun).toBe(3);
    expect(result.terminalState).toBe('max_polls_reached');
  });

  it('sleeps the configured interval between polls but not after the last', async () => {
    const { poller, sleeps } = makePoller([partial(), partial(), partial()]);
    await poller.run({ runId, repoId, repoFullName: 'o/r', prNumber: 5, cwd: '/w', phaseId: PhaseName('post-pr-review') });
    expect(sleeps).toEqual([1000, 1000]); // 2 sleeps for 3 polls
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/application test -- pr-review-poller`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the poller**

```typescript
// packages/application/src/pr-review/pr-review-poller.ts
import type { RunId, RepositoryId, PhaseName } from '@ai-sdlc/domain';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';

export interface PollPassResult {
  outcome: string;
  processed: number;
  blocked: number;
  allResolved: boolean;
  rateLimited: boolean;
}

export interface PrReviewPollerDeps {
  prReviewRepo: PrReviewRepositoryPort;
  /** Runs one ProcessPrReviewComments pass for the given poll number. */
  processOnePass: (input: {
    runId: RunId;
    repoId: RepositoryId;
    repoFullName: string;
    prNumber: number;
    cwd: string;
    phaseId: PhaseName;
    pollNumber: number;
  }) => Promise<PollPassResult>;
  eventBus: EventBusPort;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  maxPolls: number;
  pollIntervalMs: number;
  readyMaxDays: number;
}

export interface PrReviewPollerInput {
  runId: RunId;
  repoId: RepositoryId;
  repoFullName: string;
  prNumber: number;
  cwd: string;
  phaseId: PhaseName;
}

export type PollerTerminalState = 'all_resolved' | 'max_polls_reached' | 'blocked' | 'timed_out';

export interface PrReviewPollerResult {
  terminalState: PollerTerminalState;
  pollsRun: number;
}

const RATE_LIMIT_BACKOFF_MS = 60_000;

export class PrReviewPoller {
  constructor(private readonly deps: PrReviewPollerDeps) {}

  async run(input: PrReviewPollerInput): Promise<PrReviewPollerResult> {
    const d = this.deps;
    const deadline = new Date(d.now().getTime() + d.readyMaxDays * 24 * 60 * 60 * 1000);
    let pollsRun = 0;

    for (let pollNumber = 1; pollNumber <= d.maxPolls; pollNumber++) {
      if (d.now() >= deadline) {
        this.emit('post-pr-review.poll.timed_out', input, { pollNumber });
        return { terminalState: 'timed_out', pollsRun };
      }

      this.emit('post-pr-review.poll.started', input, { pollNumber });
      const pass = await d.processOnePass({ ...input, pollNumber });
      pollsRun++;

      if (pass.rateLimited) {
        this.emit('post-pr-review.poll.rate_limited', input, { pollNumber, backoffMs: RATE_LIMIT_BACKOFF_MS });
        await d.sleep(RATE_LIMIT_BACKOFF_MS);
        pollNumber--; // re-enqueue: this poll number is retried
        continue;
      }

      this.emit('post-pr-review.poll.completed', input, {
        pollNumber,
        outcome: pass.outcome,
        processed: pass.processed,
        blocked: pass.blocked,
      });

      if (pass.allResolved) {
        return { terminalState: 'all_resolved', pollsRun };
      }

      if (pollNumber < d.maxPolls) {
        await d.sleep(d.pollIntervalMs);
      }
    }

    // Reached max polls without resolution. If any comment is blocked, surface 'blocked'.
    const anyBlocked = d.prReviewRepo.listComments(input.runId).some((c) => c.state === 'blocked');
    const terminal: PollerTerminalState = anyBlocked ? 'blocked' : 'max_polls_reached';
    this.emit(`post-pr-review.poll.${terminal}`, input, { pollsRun });
    return { terminalState: terminal, pollsRun };
  }

  private emit(type: string, input: PrReviewPollerInput, metadata: Record<string, unknown>): void {
    this.deps.eventBus.publish({
      runId: input.runId,
      phase: 'post-pr-review',
      level: 'info',
      type,
      message: type,
      timestamp: this.deps.now().toISOString(),
      metadata,
    } as never);
  }
}
```

> **Implementer note:** Match the real `EventBusPort.publish` event shape — open `packages/application/src/ports/event-bus-port.ts` and shape the `emit()` payload to it exactly, removing the `as never` cast. If `publish` takes a narrower object, adapt the fields.

- [ ] **Step 4: Export from the application barrel**

In `packages/application/src/index.ts`, add:

```typescript
export * from './pr-review/pr-review-poller.js';
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/application test -- pr-review-poller && pnpm --filter @ai-sdlc/application typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/application/src/pr-review/pr-review-poller.ts packages/application/src/index.ts packages/application/src/pr-review/__tests__/pr-review-poller.test.ts
git commit -m "feat(application): PrReviewPoller in-process scheduler (M6-04)"
```

---

### Task 2: Rate-limit backoff + re-enqueue

**Files:**
- Test: extend `pr-review-poller.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
const rateLimited = (): PollPassResult => ({ outcome: 'RATE_LIMITED', processed: 0, blocked: 0, allResolved: false, rateLimited: true });

describe('PrReviewPoller — rate limit', () => {
  it('backs off and retries the same poll number on rate limit', async () => {
    // pass 1 rate-limited, then resolved.
    const { poller, sleeps, events } = makePoller([rateLimited(), resolved()]);
    const result = await poller.run({ runId, repoId, repoFullName: 'o/r', prNumber: 5, cwd: '/w', phaseId: PhaseName('post-pr-review') });
    expect(result.terminalState).toBe('all_resolved');
    expect(sleeps).toContain(60_000); // backoff happened
    expect(events.map((e) => e.type)).toContain('post-pr-review.poll.rate_limited');
  });
});
```

- [ ] **Step 2: Run to verify pass** (the skeleton handles `rateLimited`; the `pollNumber--` re-enqueues).

Run: `pnpm --filter @ai-sdlc/application test -- pr-review-poller`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/application/src/pr-review/__tests__/pr-review-poller.test.ts
git commit -m "test(application): poller backoff + re-enqueue on rate limit (M6-04)"
```

---

### Task 3: Global timeout terminates the poll

**Files:**
- Test: extend `pr-review-poller.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('PrReviewPoller — global timeout', () => {
  it('terminates as timed_out when the readyMaxDays deadline passes between polls', async () => {
    // 1ms interval but readyMaxDays so small that the second iteration is past deadline.
    const { poller } = makePoller([partial(), partial(), partial()], {
      readyMaxDays: 0, // deadline == start; first loop check trips immediately
    });
    const result = await poller.run({ runId, repoId, repoFullName: 'o/r', prNumber: 5, cwd: '/w', phaseId: PhaseName('post-pr-review') });
    expect(result.terminalState).toBe('timed_out');
    expect(result.pollsRun).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify pass** (skeleton checks `now() >= deadline` at loop top).

Run: `pnpm --filter @ai-sdlc/application test -- pr-review-poller`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/application/src/pr-review/__tests__/pr-review-poller.test.ts
git commit -m "test(application): poller honours global readyMaxDays timeout (M6-04)"
```

---

### Task 4: Composition wiring helper (assemble poller from a Container)

**Files:**
- Create: `packages/application/src/pr-review/index.ts` (barrel) — optional grouping
- Modify: `apps/api/src/compose.ts`
- Test: `apps/api/src/__tests__/compose.test.ts` (extend)

**Why:** M6-05 (Bash delegate) and M6-09/M8 callers need a single factory that builds the poller with concrete adapters. Keep the wiring in the composition root.

- [ ] **Step 1: Add a compose test assertion**

In `apps/api/src/__tests__/compose.test.ts`:

```typescript
it('exposes a buildPrReviewPoller factory', () => {
  const c = composeRoot({ repoRoot: tmpRepo, scriptPath: 'scripts/ai-run-issue-v2', dbPath: ':memory:' });
  expect(typeof c.buildPrReviewPoller).toBe('function');
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/api test -- compose`
Expected: FAIL.

- [ ] **Step 3: Wire it in `compose.ts`**

Add a factory on the container that constructs `ProcessPrReviewComments` (with `GhCliAdapter`, `GitCliAdapter` or existing git adapter, `agentRuntime`, `prReviewRepository`, `extractResult`, prompt renderer, and validation-based build verification) and wraps it in a `PrReviewPoller`. Sketch:

```typescript
// imports
import {
  ProcessPrReviewComments,
  PrReviewPoller,
  extractResult, // from M4-05; confirm the exported name
} from '@ai-sdlc/application';
import { GhCliAdapter } from '@ai-sdlc/infrastructure';

// inside composeRoot, after prReviewRepository is built and agentRuntime resolved:
const github = new GhCliAdapter({});

function buildPrReviewPoller(opts: { maxPolls: number; pollIntervalMs: number; readyMaxDays: number; cwd: string; }) {
  if (!agentRuntime) throw new ConfigError('agent config required for PR review polling');
  const process = new ProcessPrReviewComments({
    github,
    git: /* existing GitPort adapter; if none yet, inject a thin GitCliAdapter */ gitAdapter,
    agent: agentRuntime,
    prReviewRepo: prReviewRepository,
    renderPrompt: async ({ cwd }) => join(cwd, '.ai', 'pr-review-prompt.md'), // M4-03 renderer; wire real one
    extractResult: async (i) => extractResult({ ...i, registryPhase: 'post-pr-review' }),
    verifyCommitPushed: async ({ cwd, branch }) => {
      const remote = await gitAdapter.remoteRef({ cwd, remote: 'origin', ref: branch });
      const head = await gitAdapter.headCommitSha(cwd);
      return remote === head;
    },
    verifyBuildPasses: async ({ cwd }) => {
      const config = loadConfig(opts.cwd);
      const out = await runValidation.execute({
        runId: RunId('pr-review'), phaseId: PhaseName('post-pr-review'),
        cwd, logDir: join(cwd, '.ai', 'pr-verify'),
        commands: config.validation.commands, timeoutSeconds: config.validation.timeout,
      });
      return out.passed;
    },
    resolveProfileForPhase: resolveProfileForPhaseBound!,
    eventBus,
    idFactory: () => randomUUID(),
    now: () => new Date(),
    maxIterations: 10,
  });
  return new PrReviewPoller({
    prReviewRepo: prReviewRepository,
    processOnePass: (i) => process.execute(i),
    eventBus,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    maxPolls: opts.maxPolls,
    pollIntervalMs: opts.pollIntervalMs,
    readyMaxDays: opts.readyMaxDays,
  });
}

// add to Container interface + returned object:
buildPrReviewPoller: typeof buildPrReviewPoller;
```

> **Implementer notes:**
> - Confirm the real export name of the M4-05 extractor (`extractResult`) and its argument shape in `packages/application/src/results/extract-result.ts`; adapt the call.
> - If no concrete `GitPort` adapter exists yet in `packages/infrastructure` (search `implements GitPort`), add a minimal `GitCliAdapter` here or defer the real build-verify wiring; the **factory shape** is what M6-05 needs. Keep the unit tests (Tasks 1–3) green regardless — they use fakes and do not touch compose.
> - Wire the real M4-03 prompt renderer rather than the placeholder path.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/api test -- compose && pnpm --filter @ai-sdlc/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/compose.ts apps/api/src/__tests__/compose.test.ts
git commit -m "feat(api): buildPrReviewPoller factory in composition root (M6-04)"
```

---

### Task 5: Final verification

- [ ] **Step 1: Whole workspace green**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test`
Expected: all green.

---

## Self-review notes

- **Durable + observable (story goal):** Every iteration persists a `PollAttempt` (via M6-03's `recordPoll`) and emits `post-pr-review.poll.*` events the UI (M6-06) reads. The scheduler is in-process, not `nohup`.
- **Scope decision honoured:** No SQLite `JobQueuePort`/`WorkerLeasePort` adapters are built; durability rides on `poll_attempts`. The doc's `jobs` table is intentionally not used.
- **Injected time/sleep:** Tests run instantly and deterministically; production injects `setTimeout`.
- **Terminal classification:** `all_resolved` (early stop), `max_polls_reached`, `blocked` (a comment hit the 2-attempt cap), `timed_out` (`readyMaxDays`). Reactivation after a terminal `all_resolved` is M6-07.
- **Backoff:** Rate-limited passes back off 60s and retry the same poll number (re-enqueue), mirroring the Bash poller's resilience.
