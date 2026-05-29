# M5-03: Failure Classifier for Validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate each validation command record with a `kind` (`build`/`lint`/`typecheck`/`test`/`other`) and a short failure `classifier` summary, and turn a failed `ValidationRun` into a typed `Failure` so the run-level failure report and UI can say _which_ check broke.

**Architecture:** Three pure functions in `packages/application` (`classifyCommandKind`, `summarizeValidationFailure`, `validationRunToFailure`), wired into the existing `RunValidation` use case (from M5-02) which now also emits a `Failure` via `FailureRepositoryPort`. No new `FailureKind` members — the per-tool distinction lives on the record's `kind` and inside the `Failure.message`. The infra log-grep classifier is demoted to a documented fallback (comment-only, no behavior change).

**Tech Stack:** TypeScript (strict, ESM), Vitest, pnpm workspaces.

---

## Background the engineer needs

- **Depends on M5-01 + M5-02** (merged): `ValidationRun`/`ValidationCommandRecord`/`ValidationCommandKind` exist in `@ai-sdlc/domain`; `RunValidation` exists in `@ai-sdlc/application` and currently leaves `kind`/`classifier` undefined and emits no `Failure`.
- **Domain `Failure`** (`packages/domain/src/failure.ts`): `{ runUuid, phase?, step?, attempt?, kind: FailureKind, message, exitCode?, canRetry, suggestedAction, artifacts: string[], detectedAt: Date }`. `FailureKind` already includes `'validation_failed'` and `'timeout'` — **do not add new kinds.**
- **`FailureRepositoryPort`** is declared in `packages/application/src/ports.ts` (line ~135) with `insert(failure: Failure): void`. `RunValidation` will take it as a dep and call `insert`.
- **Layer rule:** still no `node:fs`/`node:path` in `packages/application`. All three functions are pure.
- **Infra classifier** `packages/infrastructure/src/failure/classifier.ts` has a `validation_failed` regex. It already prefers structured `events`/`invocation` data over log scraping (see `classify-exit.ts`). M5-03 only adds a clarifying comment cross-referencing issue #111; the regex stays as the legacy/Bash fallback.
- **Run commands:** single file `pnpm vitest run <path>`; full `pnpm -r build && pnpm -r typecheck && pnpm test && pnpm lint && pnpm depcruise`.

## File Structure

- **Create** `packages/application/src/validation/classify-validation.ts` — `classifyCommandKind`, `summarizeValidationFailure`.
- **Create** `packages/application/src/validation/validation-run-to-failure.ts` — `validationRunToFailure`.
- **Modify** `packages/application/src/index.ts` — export both.
- **Modify** `packages/application/src/run-validation.ts` — set `kind`/`classifier`; emit `Failure`.
- **Create** `packages/application/src/test-doubles/fake-failure-repository.ts` + export it.
- **Modify** `packages/application/src/__tests__/run-validation.test.ts` — pass the new dep; assert classification + failure emission.
- **Modify** `packages/infrastructure/src/failure/classifier.ts` — comment only.
- **Create** tests + fixtures.

---

## Task 1: `classifyCommandKind` + `summarizeValidationFailure`

**Files:**

- Create: `packages/application/src/validation/classify-validation.ts`
- Test: `packages/application/src/validation/__tests__/classify-validation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/application/src/validation/__tests__/classify-validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyCommandKind, summarizeValidationFailure } from '../classify-validation.js';

describe('classifyCommandKind', () => {
  it.each([
    ['pnpm build', 'build'],
    ['pnpm lint', 'lint'],
    ['pnpm typecheck', 'typecheck'],
    ['pnpm test', 'test'],
    ['pnpm test:bash', 'test'],
    ['tsc -p .', 'typecheck'],
    ['eslint .', 'lint'],
    ['echo hi', 'other'],
  ] as const)('maps %s -> %s', (command, expected) => {
    expect(classifyCommandKind(command)).toBe(expected);
  });

  it('matches typecheck before test/build to avoid substring collisions', () => {
    expect(classifyCommandKind('pnpm typecheck:test')).toBe('typecheck');
  });
});

describe('summarizeValidationFailure', () => {
  it('summarizes a timeout from duration', () => {
    const s = summarizeValidationFailure({
      outcome: 'timed_out',
      durationMs: 1500,
      stderr: '',
      stdout: '',
    });
    expect(s).toMatch(/timed out after 1500ms/i);
  });

  it('uses the tail of stderr for a failure', () => {
    const s = summarizeValidationFailure({
      outcome: 'failed',
      durationMs: 10,
      stderr: 'line1\nline2\nerror TS2345: bad\n',
      stdout: '',
    });
    expect(s).toContain('error TS2345: bad');
  });

  it('falls back to stdout when stderr is empty', () => {
    const s = summarizeValidationFailure({
      outcome: 'failed',
      durationMs: 10,
      stderr: '',
      stdout: 'FAIL src/x.test.ts',
    });
    expect(s).toContain('FAIL src/x.test.ts');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/application/src/validation/__tests__/classify-validation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/application/src/validation/classify-validation.ts`:

```ts
import type { ValidationCommandKind, ValidationCommandOutcome } from '@ai-sdlc/domain';

/**
 * Infer the kind of a validation command from its command string.
 * Order matters: 'typecheck' is checked before 'test'/'build' so that
 * commands like `typecheck:test` are not misclassified as 'test'.
 */
export function classifyCommandKind(command: string): ValidationCommandKind {
  const c = command.toLowerCase();
  if (c.includes('typecheck') || /\btsc\b/.test(c)) return 'typecheck';
  if (c.includes('lint') || c.includes('eslint')) return 'lint';
  if (c.includes('build')) return 'build';
  if (c.includes('test') || c.includes('vitest') || c.includes('jest')) return 'test';
  return 'other';
}

const MAX_TAIL_LINES = 20;

function tail(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  return lines.slice(-MAX_TAIL_LINES).join('\n');
}

/**
 * Deterministic, no-LLM one-shot summary of a failing/timed-out command.
 */
export function summarizeValidationFailure(input: {
  outcome: ValidationCommandOutcome;
  durationMs: number;
  stderr: string;
  stdout: string;
}): string {
  if (input.outcome === 'timed_out') {
    return `timed out after ${input.durationMs}ms`;
  }
  const body = input.stderr.trim().length > 0 ? input.stderr : input.stdout;
  const t = tail(body);
  return t.length > 0 ? t : 'command failed with no captured output';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/application/src/validation/__tests__/classify-validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/application/src/validation/classify-validation.ts packages/application/src/validation/__tests__/classify-validation.test.ts
git commit -m "feat(application): classifyCommandKind + summarizeValidationFailure (M5-03)"
```

---

## Task 2: `validationRunToFailure`

**Files:**

- Create: `packages/application/src/validation/validation-run-to-failure.ts`
- Test: `packages/application/src/validation/__tests__/validation-run-to-failure.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/application/src/validation/__tests__/validation-run-to-failure.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  RunId,
  PhaseName,
  type ValidationRun,
  type ValidationCommandRecord,
} from '@ai-sdlc/domain';
import { validationRunToFailure } from '../validation-run-to-failure.js';

const RUN = '55555555-5555-5555-5555-555555555555';
const AT = new Date('2026-05-28T09:00:00Z');

function cmd(o: Partial<ValidationCommandRecord> = {}): ValidationCommandRecord {
  return {
    command: 'pnpm build',
    exitCode: 0,
    durationMs: 10,
    stdoutPath: 'validate/0-build.stdout.log',
    stderrPath: 'validate/0-build.stderr.log',
    outcome: 'passed',
    kind: 'build',
    ...o,
  };
}
function run(commands: ValidationCommandRecord[]): ValidationRun {
  return { id: 'v', runId: RunId(RUN), phaseId: PhaseName('validate'), startedAt: AT, commands };
}

describe('validationRunToFailure', () => {
  it('returns null when the run passed', () => {
    expect(validationRunToFailure(run([cmd()]), AT)).toBeNull();
  });

  it('returns validation_failed naming the failing command kinds', () => {
    const f = validationRunToFailure(
      run([
        cmd(),
        cmd({
          command: 'pnpm typecheck',
          kind: 'typecheck',
          outcome: 'failed',
          exitCode: 2,
          classifier: '12 errors',
          stdoutPath: 'validate/1-typecheck.stdout.log',
          stderrPath: 'validate/1-typecheck.stderr.log',
        }),
      ]),
      AT,
    );
    expect(f).not.toBeNull();
    expect(f!.kind).toBe('validation_failed');
    expect(f!.phase).toBe('validate');
    expect(f!.message).toMatch(/typecheck/);
    expect(f!.canRetry).toBe(true);
    expect(f!.artifacts).toContain('validate/1-typecheck.stderr.log');
    expect(f!.runUuid).toBe(RUN);
    expect(f!.detectedAt).toBe(AT);
  });

  it('returns timeout when the only failures are timeouts', () => {
    const f = validationRunToFailure(
      run([
        cmd({
          command: 'pnpm test',
          kind: 'test',
          outcome: 'timed_out',
          classifier: 'timed out after 1000ms',
        }),
      ]),
      AT,
    );
    expect(f!.kind).toBe('timeout');
  });

  it('prefers validation_failed when both failures and timeouts exist', () => {
    const f = validationRunToFailure(
      run([
        cmd({ command: 'pnpm typecheck', kind: 'typecheck', outcome: 'failed', exitCode: 1 }),
        cmd({ command: 'pnpm test', kind: 'test', outcome: 'timed_out' }),
      ]),
      AT,
    );
    expect(f!.kind).toBe('validation_failed');
    expect(f!.message).toMatch(/timed out|timeout/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/application/src/validation/__tests__/validation-run-to-failure.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/application/src/validation/validation-run-to-failure.ts`:

```ts
import { validationRunPassed, type Failure, type ValidationRun } from '@ai-sdlc/domain';

/**
 * Build a run-level Failure from a ValidationRun. Returns null when the run
 * passed. Uses 'validation_failed' when any command failed; 'timeout' only when
 * the sole failures are timeouts. Validation is deterministic, so canRetry=true.
 */
export function validationRunToFailure(run: ValidationRun, detectedAt: Date): Failure | null {
  if (validationRunPassed(run)) return null;

  const failed = run.commands.filter((c) => c.outcome === 'failed');
  const timedOut = run.commands.filter((c) => c.outcome === 'timed_out');
  const bad = [...failed, ...timedOut];
  if (bad.length === 0) return null; // defensive: not passed but nothing bad => empty list

  const kind: Failure['kind'] = failed.length > 0 ? 'validation_failed' : 'timeout';

  const parts = bad.map((c) => {
    const label = c.kind ?? 'other';
    const detail =
      c.outcome === 'timed_out'
        ? 'timed out'
        : c.classifier
          ? c.classifier.split('\n').slice(-1)[0]
          : `exit ${c.exitCode}`;
    return `${label} (${detail})`;
  });
  const message = `${bad.length} validation command(s) failed: ${parts.join(', ')}. See validate/ logs.`;

  const artifacts = bad.flatMap((c) => [c.stdoutPath, c.stderrPath]);

  return {
    runUuid: run.runId,
    phase: run.phaseId,
    kind,
    message,
    canRetry: true,
    suggestedAction: 'Open the validate phase logs and rerun the failing command(s) locally.',
    artifacts,
    detectedAt,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/application/src/validation/__tests__/validation-run-to-failure.test.ts`
Expected: PASS.

- [ ] **Step 5: Export both from the application index**

Modify `packages/application/src/index.ts` — add:

```ts
export * from './validation/classify-validation.js';
export * from './validation/validation-run-to-failure.js';
```

- [ ] **Step 6: Commit**

```bash
git add packages/application/src/validation/validation-run-to-failure.ts packages/application/src/validation/__tests__/validation-run-to-failure.test.ts packages/application/src/index.ts
git commit -m "feat(application): validationRunToFailure (M5-03)"
```

---

## Task 3: Fake failure repository (test double)

**Files:**

- Create: `packages/application/src/test-doubles/fake-failure-repository.ts`
- Modify: `packages/application/src/test-doubles/index.ts`

- [ ] **Step 1: Implement the fake**

Create `packages/application/src/test-doubles/fake-failure-repository.ts`:

```ts
import type { Failure } from '@ai-sdlc/domain';
import type { FailureRepositoryPort } from '../ports.js';

export class FakeFailureRepository implements FailureRepositoryPort {
  inserted: Failure[] = [];
  insert(failure: Failure): void {
    this.inserted.push(failure);
  }
  findLatestByRun(runUuid: string): Failure | undefined {
    return [...this.inserted].reverse().find((f) => f.runUuid === runUuid);
  }
}
```

> If `FailureRepositoryPort` has more methods than `insert`/`findLatestByRun`, open `packages/application/src/ports.ts` and implement every method (return sensible defaults). The goal is a structurally-complete fake.

- [ ] **Step 2: Export it**

Modify `packages/application/src/test-doubles/index.ts` — add:

```ts
export * from './fake-failure-repository.js';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @ai-sdlc/application typecheck`
Expected: passes (if it complains about missing port methods, add them per the note above).

- [ ] **Step 4: Commit**

```bash
git add packages/application/src/test-doubles/fake-failure-repository.ts packages/application/src/test-doubles/index.ts
git commit -m "test(application): add FakeFailureRepository (M5-03)"
```

---

## Task 4: Wire classification + failure emission into `RunValidation`

**Files:**

- Modify: `packages/application/src/run-validation.ts`
- Modify: `packages/application/src/__tests__/run-validation.test.ts`

- [ ] **Step 1: Extend the existing use-case test**

Edit `packages/application/src/__tests__/run-validation.test.ts`. Update the imports and the `makeUseCase` helper, and add two new assertions.

Add to imports:

```ts
import { FakeFailureRepository } from '../test-doubles/fake-failure-repository.js';
```

Replace the `makeUseCase` helper with a version that injects a failure repo and returns it:

```ts
function makeUseCase(port: FakeValidationPort, repo: FakeValidationRunRepository) {
  let n = 0;
  const failureRepository = new FakeFailureRepository();
  const useCase = new RunValidation({
    validation: port,
    validationRunRepository: repo,
    failureRepository,
    idFactory: () => `vrun-${++n}`,
    now: () => new Date('2026-05-28T12:00:00Z'),
  });
  return { useCase, failureRepository };
}
```

Update every call site in the file from `const useCase = makeUseCase(...)` / `makeUseCase(port, repo).execute(...)` to destructure:

```ts
const { useCase } = makeUseCase(port, repo);
```

(For the call sites that chained `.execute` directly, assign first: `const { useCase } = makeUseCase(port, repo); await useCase.execute(...)`.)

Then add a new test:

```ts
it('classifies command kinds and emits a validation_failed Failure', async () => {
  const port = new FakeValidationPort();
  port.result = [
    {
      command: 'pnpm build',
      exitCode: 0,
      durationMs: 5,
      stdout: 'ok',
      stderr: '',
      stdoutPath: 'validate/0-build.stdout.log',
      stderrPath: 'validate/0-build.stderr.log',
      outcome: 'passed',
    },
    {
      command: 'pnpm typecheck',
      exitCode: 2,
      durationMs: 9,
      stdout: '',
      stderr: 'error TS2345',
      stdoutPath: 'validate/1-typecheck.stdout.log',
      stderrPath: 'validate/1-typecheck.stderr.log',
      outcome: 'failed',
    },
  ];
  const repo = new FakeValidationRunRepository();
  const { useCase, failureRepository } = makeUseCase(port, repo);
  const out = await useCase.execute({
    runId: RUN,
    phaseId: PhaseName('validate'),
    cwd: '/work',
    logDir: '/d',
    commands: ['pnpm build', 'pnpm typecheck'],
    timeoutSeconds: 300,
  });
  expect(out.validationRun.commands[0].kind).toBe('build');
  expect(out.validationRun.commands[1].kind).toBe('typecheck');
  expect(out.validationRun.commands[1].classifier).toContain('error TS2345');
  expect(failureRepository.inserted).toHaveLength(1);
  expect(failureRepository.inserted[0].kind).toBe('validation_failed');
});

it('emits no Failure when validation passes', async () => {
  const port = new FakeValidationPort();
  port.result = [
    {
      command: 'pnpm build',
      exitCode: 0,
      durationMs: 5,
      stdout: '',
      stderr: '',
      stdoutPath: 'validate/0-build.stdout.log',
      stderrPath: 'validate/0-build.stderr.log',
      outcome: 'passed',
    },
  ];
  const repo = new FakeValidationRunRepository();
  const { useCase, failureRepository } = makeUseCase(port, repo);
  await useCase.execute({
    runId: RUN,
    phaseId: PhaseName('validate'),
    cwd: '/w',
    logDir: '/d',
    commands: ['pnpm build'],
    timeoutSeconds: 300,
  });
  expect(failureRepository.inserted).toHaveLength(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/application/src/__tests__/run-validation.test.ts`
Expected: FAIL — `RunValidation` deps don't accept `failureRepository`; `kind`/`classifier` undefined.

- [ ] **Step 3: Update the use case**

Edit `packages/application/src/run-validation.ts`:

1. Update imports:

```ts
import {
  validationRunPassed,
  type RunId,
  type PhaseName,
  type ValidationRun,
  type ValidationCommandRecord,
} from '@ai-sdlc/domain';
import type { ValidationPort } from './ports/validation-port.js';
import type { ValidationRunRepositoryPort } from './ports/validation-run-repository-port.js';
import type { FailureRepositoryPort } from './ports.js';
import {
  classifyCommandKind,
  summarizeValidationFailure,
} from './validation/classify-validation.js';
import { validationRunToFailure } from './validation/validation-run-to-failure.js';
```

2. Add `failureRepository` to `RunValidationDeps`:

```ts
export interface RunValidationDeps {
  validation: ValidationPort;
  validationRunRepository: ValidationRunRepositoryPort;
  failureRepository: FailureRepositoryPort;
  idFactory: () => string;
  now: () => Date;
}
```

3. Replace the `commands` mapping block with classification:

```ts
const commands: ValidationCommandRecord[] = results.map((r) => ({
  command: r.command,
  exitCode: r.exitCode,
  durationMs: r.durationMs,
  stdoutPath: r.stdoutPath,
  stderrPath: r.stderrPath,
  outcome: r.outcome,
  kind: classifyCommandKind(r.command),
  ...(r.outcome !== 'passed'
    ? {
        classifier: summarizeValidationFailure({
          outcome: r.outcome,
          durationMs: r.durationMs,
          stderr: r.stderr,
          stdout: r.stdout,
        }),
      }
    : {}),
}));
```

4. After `this.deps.validationRunRepository.save(validationRun);` and before the `return`, add:

```ts
const failure = validationRunToFailure(validationRun, this.deps.now());
if (failure) this.deps.failureRepository.insert(failure);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/application/src/__tests__/run-validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/application/src/run-validation.ts packages/application/src/__tests__/run-validation.test.ts
git commit -m "feat(application): RunValidation classifies kinds + emits Failure (M5-03)"
```

---

## Task 5: Update the composition root + demote infra regex to fallback

**Files:**

- Modify: `apps/api/src/compose.ts`
- Modify: `packages/infrastructure/src/failure/classifier.ts`

- [ ] **Step 1: Pass `failureRepository` into `RunValidation` in compose.ts**

In `apps/api/src/compose.ts`, the `new RunValidation({ ... })` block (added in M5-02) now needs the failure repo. `failureRepository` is already constructed in compose. Update to:

```ts
const runValidation = new RunValidation({
  validation: validationAdapter,
  validationRunRepository,
  failureRepository,
  idFactory: () => randomUUID(),
  now: () => new Date(),
});
```

- [ ] **Step 2: Add the fallback comment in the infra classifier**

In `packages/infrastructure/src/failure/classifier.ts`, find the `validation_failed` pattern in the `PATTERNS` array and add a comment directly above it:

```ts
// Legacy/Bash fallback only. When the TypeScript validation runner records a
// structured ValidationRun (M5-02/M5-03), RunValidation already inserts a
// typed validation_failed/timeout Failure; this regex covers runs that did
// not produce structured validation data (older runs, pre-cutover Bash).
// See issue #111 (prefer exit codes / structured signals over log patterns).
```

(No behavior change — the regex stays.)

- [ ] **Step 3: Run the infra classifier tests**

Run: `pnpm vitest run packages/infrastructure/src/failure/__tests__/classifier.test.ts`
Expected: PASS (unchanged behavior).

- [ ] **Step 4: Full verification**

Run: `pnpm -r build && pnpm -r typecheck && pnpm test && pnpm lint && pnpm depcruise`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/compose.ts packages/infrastructure/src/failure/classifier.ts
git commit -m "feat: wire validation failure emission; document legacy classifier fallback (M5-03)"
```

---

## Self-review checklist (run before handoff)

- [ ] Spec coverage: `classifyCommandKind` mapping + ordering ✔ (Task 1); every record gets a `kind`, failing ones get `classifier` ✔ (Task 4); `validation_failed` naming the kind + linking logs ✔ (Task 2); timeout-only → `timeout` ✔ (Task 2); pass → no Failure ✔ (Task 2/4); fallback comment + #111 ✔ (Task 5).
- [ ] Type consistency: `classifyCommandKind` returns `ValidationCommandKind`; `summarizeValidationFailure` input matches what `RunValidation` passes (`outcome`/`durationMs`/`stderr`/`stdout`); `validationRunToFailure(run, detectedAt)` signature matches the call site.
- [ ] No new `FailureKind` members added.
- [ ] Layer purity: all three functions import only `@ai-sdlc/domain`; `pnpm depcruise` clean.

## Out of scope (do NOT implement here)

- API endpoint + UI (M5-04).
- Bash cutover + CLI (M5-05).
- Removing the infra `validation_failed` regex (kept as fallback).
