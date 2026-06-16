# M8-05: validate Phase Handler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `validate` phase handler as a thin wrapper over the existing `RunValidation` use case: run the configured validation commands, set the phase outcome from the structured result, and emit a `validation_failed` failure (keeping the run in `validate`, never advancing to `create-pr`) when any command fails.

**Architecture:** `ValidateHandler` calls the existing `RunValidation` class (`packages/application/src/run-validation.ts`), which already executes commands via `ValidationPort`, classifies failures, persists a `ValidationRun`, and returns `{ validationRun, passed }`. The handler maps that to a `PhaseResult`. No command-execution or classification logic is duplicated.

**Tech Stack:** TypeScript (strict, ESM), Vitest, `@ai-sdlc/domain`, `RunValidation`.

---

## Critical context (read first)

- **Reuse `RunValidation`** (`packages/application/src/run-validation.ts`). Its `execute(input: { runId, phaseId, cwd, logDir, commands, timeoutSeconds, logPathPrefix? })` returns `{ validationRun: ValidationRun, passed: boolean }`. It already writes failures via `FailureRepositoryPort` and persists the run via `ValidationRunRepositoryPort`. **Do not re-run or re-classify commands.**
- The `validation-result.json` artifact is written by `ProcessValidationAdapter` (infrastructure), not by the use case. The handler does not write it.
- **Open Question 1 (PRD §30):** failed validation keeps the run in `validate` (retry or fail) — **no draft PR, no advance**. The handler returns `failed`; the executor (M8-10) is responsible for not advancing on a failed phase.
- Config: `validation.commands` and `validation.timeout` come from `.ai-orchestrator.json` (loaded by `loadConfig` in `@ai-sdlc/shared`). The handler receives them via context/options, it does not parse config itself.
- Builds on M8-02 `PhaseHandler` and the M8-03 extended context.
- Test doubles: `FakeValidationPort`, `FakeValidationRunRepository`, `FakeFailureRepository` exist in `packages/application/src/test-doubles/`.

## File structure

- Create: `packages/application/src/phases/handlers/validate.ts`
- Create: `packages/application/src/phases/handlers/__tests__/validate.test.ts`
- Modify: `packages/application/src/phases/index.ts`

---

### Task 1: ValidateHandler — all-pass path

**Files:**
- Create: `packages/application/src/phases/handlers/validate.ts`
- Test: `packages/application/src/phases/handlers/__tests__/validate.test.ts`

- [ ] **Step 1: Write the failing test** (wire a `RunValidation` with fakes, scripted to pass):

```ts
import { describe, it, expect } from 'vitest';
import { ValidateHandler } from '../validate.js';
import { RunValidation } from '../../../run-validation.js';
import { FakeValidationPort } from '../../../test-doubles/fake-validation-port.js';
import { FakeValidationRunRepository } from '../../../test-doubles/fake-validation-run-repository.js';
import { FakeFailureRepository } from '../../../test-doubles/fake-failure-repository.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

function deps(passing: boolean) {
  const validation = new FakeValidationPort();
  // Inspect FakeValidationPort for how to script results; e.g. it returns
  // one ValidationCommandResult per command. Make exitCode 0 (pass) or 1 (fail).
  validation.script(['pnpm build'], passing ? 'passed' : 'failed');
  const runValidation = new RunValidation({
    validation,
    validationRunRepository: new FakeValidationRunRepository(),
    failureRepository: new FakeFailureRepository(),
    idFactory: () => 'vr1',
    now: () => new Date('2026-06-16T00:00:00Z'),
  });
  return { runValidation, validation };
}

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

describe('ValidateHandler', () => {
  it('returns passed when all commands pass', async () => {
    const { runValidation } = deps(true);
    const { ctx: c } = ctx();
    const res = await new ValidateHandler({
      runValidation, commands: ['pnpm build'], timeoutSeconds: 300, logDir: '/wt/.ai-runs/r1/validate',
    }).run(c);
    expect(res.outcome).toBe('passed');
  });
});
```

> Open `packages/application/src/test-doubles/fake-validation-port.ts` to confirm the exact scripting API (`.script(...)` is illustrative). Adjust the seed call to match.

- [ ] **Step 2: Run to verify failure.** `pnpm exec vitest run packages/application/src/phases/handlers/__tests__/validate.test.ts` → FAIL.

- [ ] **Step 3: Implement `validate.ts`:**

```ts
import type { PhaseName, RunId } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';
import type { RunValidation } from '../../run-validation.js';

export interface ValidateHandlerOpts {
  runValidation: RunValidation;
  commands: string[];
  timeoutSeconds: number;
  logDir: string;
}

export class ValidateHandler implements PhaseHandler {
  readonly phase = 'validate' as PhaseName;
  constructor(private readonly opts: ValidateHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    this.emit(ctx, 'phase.started', 'info', 'validate started');

    const { passed, validationRun } = await this.opts.runValidation.execute({
      runId: ctx.runUuid as RunId,
      phaseId: this.phase,
      cwd: ctx.cwd,
      logDir: this.opts.logDir,
      commands: this.opts.commands,
      timeoutSeconds: this.opts.timeoutSeconds,
    });

    if (passed) {
      this.emit(ctx, 'phase.completed', 'info', 'validation passed', {
        commands: validationRun.commands.length,
      });
      return { outcome: 'passed' };
    }

    const failing = validationRun.commands.filter((c) => c.outcome !== 'passed').map((c) => c.command);
    this.emit(ctx, 'phase.failed', 'error', `validation failed: ${failing.join(', ')}`, { failing });
    return {
      outcome: 'failed',
      failure: {
        runUuid: ctx.runUuid,
        phase: 'validate',
        kind: 'validation_failed',
        message: `validation failed: ${failing.join(', ')}`,
        canRetry: true,
        suggestedAction: 'Inspect the failing command logs under the validate phase, fix, and resume.',
        artifacts: ['validate/validation-result.json'],
        detectedAt: ctx.now(),
      },
    };
  }

  private emit(ctx: PhaseHandlerContext, type: string, level: 'info' | 'warn' | 'error', message: string, metadata: Record<string, unknown> = {}): void {
    ctx.events.publish(ctx.runUuid, { runId: ctx.runUuid, phase: 'validate', level, type, message, timestamp: ctx.now().toISOString(), metadata });
  }
}
```

- [ ] **Step 4: Run to verify pass.** → PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): validate phase handler (thin RunValidation wrapper)"`

---

### Task 2: Any-fail path

**Files:**
- Test: same file

- [ ] **Step 1: Add failing test:**

```ts
it('returns validation_failed when a command fails', async () => {
  const { runValidation } = deps(false);
  const { ctx: c } = ctx();
  const res = await new ValidateHandler({
    runValidation, commands: ['pnpm build'], timeoutSeconds: 300, logDir: '/wt/.ai-runs/r1/validate',
  }).run(c);
  expect(res.outcome).toBe('failed');
  expect(res.failure?.kind).toBe('validation_failed');
});
```

- [ ] **Step 2: Run.** Should already PASS given Task 1 logic. If `FakeValidationPort` scripting differs, fix the seeding.

- [ ] **Step 3: Commit** `git add -A && git commit -m "test(application): validate handler failure path"`

---

### Task 3: Export + boundaries + full suite

- [ ] **Step 1:** Append `export * from './handlers/validate.js';` to `packages/application/src/phases/index.ts`.
- [ ] **Step 2:** `pnpm -r typecheck && pnpm lint && pnpm depcruise && pnpm test` → all PASS.
- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(application): export validate phase handler"`

---

## Self-review checklist

- [ ] Acceptance → tests: all-pass → passed (Task 1), any-fail → `validation_failed` (Task 2). Phase-failure-does-not-advance is enforced by the executor (M8-10), not here — noted.
- [ ] Thin wrapper: no command execution or classification logic duplicated from M5/`RunValidation`.
- [ ] `validation-result.json` not written by the handler.
- [ ] Names consistent: `ValidateHandler`, `ValidateHandlerOpts`.

## Definition of done

Merged with green CI; deterministic pass/fail mapping proven; zero duplication of M5 logic; failure keeps the run in `validate`.
