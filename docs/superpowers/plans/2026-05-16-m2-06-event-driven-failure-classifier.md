# M2-06: Failure Events Enrich `failure.json` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the failure classifier introduced in M1-06 so it prefers the structured events emitted in M2-02 over log scraping. When a `phase.failed` event was emitted, the classifier reads its `metadata` (`command`, `exitCode`, `missingArtifact`, `reason`) and builds the `Failure` record directly. Falls back to the existing M1-06 log-scraping behaviour when no `phase.failed` event exists.

**Architecture:**

- New input field `events?: OrchestratorEvent[]` is added to `ClassifyExitInput`.
- `classifyExit` first looks for the most recent `phase.failed` event (or any `*.failed` / `loop.exhausted` for fix-review). If one is found, it builds the `Failure` from that event's metadata; otherwise it falls through to the existing log-tail logic.
- The application layer (`StartIssueRun`) reads the events it accumulated via the M2-04 tailer and passes them to `classifyExitAdapter`.
- All M1-06 behaviour is preserved when `events` is absent or empty — no regressions in existing fixture tests.

**Tech Stack:** TypeScript strict, Vitest. No new runtime dependencies.

---

## Required reading

- `packages/infrastructure/src/failure/classifier.ts` — current implementation.
- `packages/domain/src/failure.ts` — `Failure`, `FailureKind`, `ClassifyExitInput` types.
- `packages/shared/src/events/schema.ts` (M2-04) — event shape.
- M2-02 event vocabulary (specifically `phase.failed`, `loop.exhausted`).

---

## Mapping rules (event metadata → `Failure`)

When the most recent terminal event is consulted, derive `Failure` fields:

| Event predicate / metadata                                          | `Failure.kind`      | `Failure.message`               | `Failure.suggestedAction`                            |
| ------------------------------------------------------------------- | ------------------- | ------------------------------- | ---------------------------------------------------- |
| `type == 'phase.failed' && metadata.missingArtifact`                | `missing_artifact`  | `Missing artifact: ${path}`     | _existing M1-06 missing_artifact action_             |
| `type == 'phase.failed' && metadata.reason ~ /invalid result/i`     | `invalid_result`    | event.message                   | _existing invalid_result action_                     |
| `type == 'phase.failed' && metadata.reason ~ /branch/i`             | `branch_changed`    | event.message                   | _existing branch_changed action_                     |
| `type == 'phase.failed' && metadata.reason ~ /timeout\|timed out/i` | `timeout`           | event.message                   | _existing timeout action_                            |
| `type == 'phase.failed' && phase == 'validate' && metadata.command` | `validation_failed` | `${command} exited ${exitCode}` | _existing validation_failed action_                  |
| `type == 'phase.failed' && metadata.reason ~ /blocked\|BLOCKED/`    | `agent_blocked`     | event.message                   | _existing agent_blocked action_                      |
| `type == 'phase.failed'` (no other rule matched) && exitCode given  | `command_failed`    | event.message                   | _generic action_                                     |
| `type == 'loop.exhausted'` (fix-review)                             | `agent_blocked`     | event.message                   | _agent_blocked action_                               |
| `type == 'run.failed'` only (no phase.failed)                       | `unknown`           | event.message                   | "Inspect combined.log and stderr.log for the cause." |

`Failure.phase` is the event's `phase` field (or `undefined` for run-level events).
`Failure.exitCode` comes from `metadata.exitCode` if a number, otherwise from `input.exitCode`.
`Failure.canRetry` stays `false` (PRD §28 risk 3 — never auto-mark safe in MVP).
`Failure.detectedAt` comes from the event's timestamp.
`Failure.artifacts` comes from `input.artifacts ?? []`.

If no terminal event (`phase.failed` / `loop.exhausted` / `run.failed`) is found, fall through to the existing log-scraping path.

---

## File Structure

| Path                                                               | Action                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `packages/domain/src/failure.ts`                                   | Modify (extend `ClassifyExitInput`).                               |
| `packages/infrastructure/src/failure/classifier.ts`                | Modify (event-driven branch, then fallback).                       |
| `packages/infrastructure/src/failure/__tests__/classifier.test.ts` | Modify (existing tests stay green; add event-driven cases).        |
| `packages/application/src/<StartIssueRun>.ts`                      | Modify (collect events as tailer emits, pass into `classifyExit`). |

---

## Task 1: Extend `ClassifyExitInput`

**Files:**

- Modify: `packages/domain/src/failure.ts`

- [ ] **Step 1: Add optional `events` field**

Locate `ClassifyExitInput` in `packages/domain/src/failure.ts`. Add:

```ts
import type { OrchestratorEvent } from '@ai-sdlc/shared';

export interface ClassifyExitInput {
  runUuid: string;
  exitCode: number;
  combinedLogTail: string;
  artifacts?: string[];
  detectedAt?: Date;
  /** Optional structured event stream from the wrapped run. When provided
   *  and a terminal event exists, the classifier prefers events over
   *  log scraping. */
  events?: OrchestratorEvent[];
}
```

If the domain package cannot import from `@ai-sdlc/shared` due to layering, instead inline the minimum shape needed:

```ts
export interface ClassifierEvent {
  phase?: string;
  level: 'info' | 'warn' | 'error';
  type: string;
  message: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface ClassifyExitInput {
  // ...existing
  events?: ClassifierEvent[];
}
```

Choose whichever is consistent with existing imports — check by running `grep -n "@ai-sdlc/shared" packages/domain/src/*.ts`.

- [ ] **Step 2: Verify everything still compiles**

Run: `pnpm -r build`
Expected: green build (no consumer was passing `events` yet, and the field is optional).

- [ ] **Step 3: Commit**

```bash
git add packages/domain
git commit -m "feat(domain): add optional events field to ClassifyExitInput"
```

---

## Task 2: Add failing tests for event-driven classification

**Files:**

- Modify: `packages/infrastructure/src/failure/__tests__/classifier.test.ts`

- [ ] **Step 1: Read the existing test file first**

Run: `cat packages/infrastructure/src/failure/__tests__/classifier.test.ts`

This is to preserve all existing tests; we only ADD new cases.

- [ ] **Step 2: Append the new cases**

```ts
describe('classifyExit with events (M2-06)', () => {
  const baseInput = {
    runUuid: '00000000-0000-0000-0000-000000000001',
    combinedLogTail: '',
    artifacts: [],
  };

  const ev = (over: Partial<ClassifierEvent>): ClassifierEvent => ({
    level: 'error',
    type: 'phase.failed',
    message: '',
    timestamp: '2026-05-16T12:00:00.000Z',
    metadata: {},
    ...over,
  });

  it('prefers phase.failed metadata over log scraping for validation', () => {
    const failure = classifyExit({
      ...baseInput,
      exitCode: 1,
      events: [
        ev({
          phase: 'validate',
          message: 'validate suite failed',
          metadata: { command: 'pnpm build', exitCode: 2, reason: 'build failed' },
        }),
      ],
      // log tail *would* otherwise classify differently; prove we ignore it.
      combinedLogTail: 'gh: api error\nfatal: nothing here',
    });
    expect(failure.kind).toBe('validation_failed');
    expect(failure.phase).toBe('validate');
    expect(failure.message).toMatch(/pnpm build/);
    expect(failure.exitCode).toBe(2);
  });

  it('classifies missing_artifact when metadata.missingArtifact is set', () => {
    const failure = classifyExit({
      ...baseInput,
      exitCode: 1,
      events: [
        ev({
          phase: 'plan-write',
          message: 'plan.md missing',
          metadata: { missingArtifact: 'plan.md' },
        }),
      ],
    });
    expect(failure.kind).toBe('missing_artifact');
    expect(failure.phase).toBe('plan-write');
    expect(failure.message).toMatch(/plan\.md/);
  });

  it('classifies branch_changed via metadata.reason', () => {
    const failure = classifyExit({
      ...baseInput,
      exitCode: 1,
      events: [
        ev({
          phase: 'implement',
          message: 'switched branch from ai/issue-1 to main',
          metadata: { reason: 'branch changed' },
        }),
      ],
    });
    expect(failure.kind).toBe('branch_changed');
  });

  it('classifies agent_blocked from loop.exhausted', () => {
    const failure = classifyExit({
      ...baseInput,
      exitCode: 1,
      events: [
        ev({
          phase: 'fix-review',
          type: 'loop.exhausted',
          message: 'fix-review hit max iterations for task 2',
          metadata: { task: 2, iterations: 5 },
        }),
      ],
    });
    expect(failure.kind).toBe('agent_blocked');
    expect(failure.phase).toBe('fix-review');
  });

  it('falls back to log scraping when no terminal event present', () => {
    const failure = classifyExit({
      ...baseInput,
      exitCode: 1,
      events: [ev({ phase: 'plan-write', type: 'phase.started', level: 'info' })],
      combinedLogTail: 'pnpm typecheck failed',
    });
    expect(failure.kind).toBe('validation_failed');
  });

  it('uses the events timestamp for detectedAt', () => {
    const failure = classifyExit({
      ...baseInput,
      exitCode: 1,
      events: [
        ev({
          phase: 'validate',
          message: 'build failed',
          metadata: { command: 'pnpm build', exitCode: 2 },
        }),
      ],
    });
    expect(failure.detectedAt.toISOString()).toBe('2026-05-16T12:00:00.000Z');
  });

  it('uses the most recent phase.failed when multiple exist', () => {
    const failure = classifyExit({
      ...baseInput,
      exitCode: 1,
      events: [
        ev({
          phase: 'validate',
          message: 'first',
          metadata: { reason: 'timed out' },
          timestamp: '2026-05-16T12:00:00.000Z',
        }),
        ev({
          phase: 'review',
          message: 'second',
          metadata: { reason: 'BLOCKED' },
          timestamp: '2026-05-16T12:01:00.000Z',
        }),
      ],
    });
    expect(failure.kind).toBe('agent_blocked');
    expect(failure.phase).toBe('review');
  });

  it('returns unknown when only run.failed is present (no phase context)', () => {
    const failure = classifyExit({
      ...baseInput,
      exitCode: 1,
      events: [
        ev({
          type: 'run.failed',
          message: 'something exploded',
          metadata: { reason: 'something exploded', lastPhase: 'implement' },
        }),
      ],
    });
    expect(failure.kind).toBe('unknown');
    expect(failure.message).toMatch(/something exploded/);
  });
});
```

(Add the `import { ClassifierEvent }` or `import { OrchestratorEvent }` matching whatever Task 1 chose.)

- [ ] **Step 3: Run, verify failure**

Run: `pnpm --filter @ai-sdlc/infrastructure test`
Expected: existing tests still pass; 8 new tests fail.

- [ ] **Step 4: Commit (failing)**

```bash
git add packages/infrastructure
git commit -m "test(infra): event-driven classifier expectations (failing)"
```

---

## Task 3: Implement the event-driven branch in `classifyExit`

**Files:**

- Modify: `packages/infrastructure/src/failure/classifier.ts`

- [ ] **Step 1: Add the event-first branch**

At the top of `classifyExit`, before the existing log-scraping logic:

```ts
if (input.events && input.events.length > 0) {
  const terminal = pickTerminalEvent(input.events);
  if (terminal) {
    return buildFailureFromEvent(terminal, input);
  }
}
```

Then add the helpers at the bottom of the file:

```ts
type TerminalEvent = NonNullable<ClassifyExitInput['events']>[number];

function pickTerminalEvent(
  events: NonNullable<ClassifyExitInput['events']>,
): TerminalEvent | undefined {
  // Prefer the most recent phase.failed; then loop.exhausted; then run.failed.
  const phaseFailed = lastOf(events, (e) => e.type === 'phase.failed');
  if (phaseFailed) return phaseFailed;
  const loopExhausted = lastOf(events, (e) => e.type === 'loop.exhausted');
  if (loopExhausted) return loopExhausted;
  const runFailed = lastOf(events, (e) => e.type === 'run.failed');
  return runFailed;
}

function lastOf<T>(arr: T[], pred: (t: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return arr[i];
  }
  return undefined;
}

function buildFailureFromEvent(e: TerminalEvent, input: ClassifyExitInput): Failure {
  const meta = e.metadata ?? {};
  const reason = typeof meta.reason === 'string' ? meta.reason : '';
  const missingArtifact =
    typeof meta.missingArtifact === 'string' ? meta.missingArtifact : undefined;
  const command = typeof meta.command === 'string' ? meta.command : undefined;
  const metaExit = typeof meta.exitCode === 'number' ? meta.exitCode : undefined;

  let kind: FailureKind;
  let message = e.message || '';
  let suggestedAction = 'Inspect the failed phase artifacts and stderr.log.';

  if (e.type === 'loop.exhausted') {
    kind = 'agent_blocked';
    suggestedAction = 'The fix-review loop hit max iterations — inspect the latest review.md.';
  } else if (e.type === 'run.failed') {
    kind = 'unknown';
    suggestedAction = 'Inspect combined.log and stderr.log for the cause.';
  } else if (missingArtifact !== undefined) {
    kind = 'missing_artifact';
    message = `Missing artifact: ${missingArtifact}`;
    suggestedAction =
      'Inspect the phase prompt and stdout; the agent did not produce the expected file.';
  } else if (/invalid result/i.test(reason)) {
    kind = 'invalid_result';
    suggestedAction = 'Inspect the agent result.json and prompt template.';
  } else if (/branch/i.test(reason)) {
    kind = 'branch_changed';
    suggestedAction =
      'Reset the worktree branch and retry; verify the agent prompt does not switch branches.';
  } else if (/timeout|timed out/i.test(reason)) {
    kind = 'timeout';
    suggestedAction = 'Raise invocationMaxMinutes or investigate why the agent hung.';
  } else if (/blocked/i.test(reason)) {
    kind = 'agent_blocked';
    suggestedAction = 'The agent blocked itself — review the prompt and the reported reason.';
  } else if (e.phase === 'validate' && command !== undefined) {
    kind = 'validation_failed';
    message = `${command} exited ${metaExit ?? input.exitCode}`;
    suggestedAction = 'Open the validate phase logs and rerun the failing command locally.';
  } else {
    kind = 'command_failed';
  }

  const failure: Failure = {
    runUuid: input.runUuid,
    kind,
    message: message || `Detected ${kind}`,
    exitCode: metaExit ?? input.exitCode,
    canRetry: false,
    suggestedAction,
    artifacts: input.artifacts ?? [],
    detectedAt: new Date(e.timestamp),
  };
  if (e.phase !== undefined) failure.phase = e.phase;
  return failure;
}
```

- [ ] **Step 2: Run + verify pass**

Run: `pnpm --filter @ai-sdlc/infrastructure test`
Expected: all previous tests still pass, all 8 new tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/infrastructure
git commit -m "feat(infra): event-driven branch in classifyExit"
```

---

## Task 4: Plumb events into `StartIssueRun`

**Files:**

- Modify: `packages/application/src/<StartIssueRun>.ts`

- [ ] **Step 1: Accumulate events as the tailer emits**

In M2-04 you wired `createEventTailer({ onEvent: ... })`. Extend that callback to push into a local array AND publish via the bus, in addition to inserting into the repo:

```ts
const collectedEvents: OrchestratorEvent[] = [];
const onEvent = (e: OrchestratorEvent): void => {
  collectedEvents.push(e);
  this.deps.eventRepository.insert({
    /* existing */
  });
  this.deps.eventBus.publish(run.uuid, e);
};
```

- [ ] **Step 2: Pass events into classifyExit**

After the bash child exits and the tailer is drained, change the existing `classifyExit({...})` call to include events:

```ts
const failure = this.deps.classifyExit({
  runUuid: run.uuid,
  exitCode: result.exitCode,
  combinedLogTail: runDirectory.readCombinedLog(),
  events: collectedEvents,
});
```

- [ ] **Step 3: Write a use-case test**

In the StartIssueRun test, add:

```ts
it('uses tailed events to classify the failure when phase.failed exists', async () => {
  // Build a fake tailer that emits a phase.failed event after the bash run.
  // Assert that the resulting failure.kind matches the event-driven path, not log scraping.
});
```

- [ ] **Step 4: Run + commit**

```bash
pnpm -r test
git add packages/application
git commit -m "feat(app): pass collected events into classifyExit for richer failures"
```

---

## Task 5: End-to-end smoke

**Files:**

- Modify: an existing API e2e test (e.g. `apps/api/src/__tests__/wrapper-e2e.test.ts`).

- [ ] **Step 1: Add a "fail with structured event" fake script**

Add a fixture script (e.g. `apps/api/src/__tests__/fixtures/fake-fail-with-events.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="${REPO_ROOT:-$(pwd)}"
source "$REPO_ROOT/scripts/lib/emit_event.sh"

emit_event "" info run.started "starting" issueNumber=99
emit_event "validate" info phase.started "starting validate"
emit_event "validate" error phase.failed "validate failed" command="pnpm build" exitCode=2 reason="build failed"
emit_event "" error run.failed "build failed" lastPhase="validate" reason="build failed"
exit 1
```

`chmod +x` and reference it from the test.

- [ ] **Step 2: Assert the resulting `failure.json`**

After the run completes (exit 1), assert:

```ts
const failure = container.failureRepository.findLatestByRun(run.uuid)!;
expect(failure.kind).toBe('validation_failed');
expect(failure.phase).toBe('validate');
expect(failure.exitCode).toBe(2);
expect(failure.message).toMatch(/pnpm build/);
```

- [ ] **Step 3: Run + commit**

```bash
pnpm -r test
git add apps/api
git commit -m "test(api): e2e classifier uses structured events when present"
```

---

## Self-Review Notes

- Spec coverage (M2-06 acceptance: "Stub failures produce `failure.json` with the same `kind` as the emitting event"): Tasks 2 + 3 + 5 directly verify this.
- All M1-06 tests must still pass — Task 2's new cases are ADDED, not REPLACED.
- The classifier remains free of side effects (no I/O), and the event-driven branch returns immediately when a terminal event is found.
- Out of scope: surfacing event-driven failure data in the UI failure tab — the existing failure tab reads `failure.json`, which now contains richer fields automatically.
