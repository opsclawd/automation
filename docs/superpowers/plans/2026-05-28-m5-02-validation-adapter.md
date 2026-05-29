# M5-02: ValidationAdapter Runs Configured Commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run each `.ai-orchestrator.json → validation.commands` entry as its own process, capture per-command stdout/stderr to files, apply a per-command timeout, persist a `ValidationRun`, and write a `validation-result.json` summary — without short-circuiting on the first failure.

**Architecture:** A `ProcessValidationAdapter` in `packages/infrastructure` (it owns all file I/O and `execa` execution, returning run-relative log paths) implements the existing `ValidationPort`. A pure `RunValidation` use case in `packages/application` orchestrates the port + persistence with **no** `node:fs`/`node:path` imports (a hard dependency-cruiser rule). The composition root wires them together. Classification (`kind`/`classifier`) and `Failure` emission are deliberately deferred to M5-03.

**Tech Stack:** TypeScript (strict, ESM), Vitest, `execa`, `better-sqlite3`, pnpm workspaces.

---

## Background the engineer needs

- **Depends on M5-01** (merged): `ValidationRun`, `ValidationCommandRecord`, `validationRunPassed` exist in `@ai-sdlc/domain`; `ValidationRunRepository` exists in `@ai-sdlc/infrastructure` and is on the `Container`.
- **Hard layer rule (will fail CI if violated):** `.dependency-cruiser.cjs` rule `application-no-io-except-prompt-template` forbids any `node:fs`/`node:path` import under `packages/application/src` (except one prompts file and `__tests__`). And `application-cannot-depend-on-infrastructure` forbids `packages/application` (including its tests) from importing `@ai-sdlc/infrastructure`. **Therefore:** all file writing happens in the infra adapter; the application use case is pure and is tested with fakes only.
- **Existing transient port** `packages/application/src/ports/validation-port.ts`:
  ```ts
  export interface ValidationCommandResult {
    command;
    exitCode;
    durationMs;
    stdout;
    stderr;
  }
  export interface RunValidationInput {
    cwd;
    commands;
    timeoutSeconds;
  }
  export interface ValidationPort {
    run(input): Promise<ValidationCommandResult[]>;
  }
  ```
  We extend it (add file paths + outcome + log-dir input). `FakeValidationPort` (`packages/application/src/test-doubles/fake-validation-port.ts`) must be updated to match.
- **Adapter pattern to copy:** `packages/infrastructure/src/agent/opencode-adapter.ts` — shows `execa(..., { cwd, reject: false })`, `AbortSignal.timeout`, per-call output dirs, `mkdirSync(dir,{recursive:true})`, `writeFileSync`. `execa` is already an infra dependency.
- **`execa` usage:** to run a shell command string (e.g. `pnpm test:bash`), use `execa(command, { shell: true, cwd, reject: false, all: false, cancelSignal })`. `shell: true` is required because entries contain `:` and may contain `&&`. Commands come from operator-authored config — not untrusted input.
- **Injected impurities (id/clock):** mirror `agent-runtime-router.ts` which takes `idFactory: () => randomUUID()`. The pure use case takes `idFactory` and `now` so tests are deterministic.
- **Run commands:** single file `pnpm vitest run <path>`; by name add `-t "<name>"`; full `pnpm -r build && pnpm -r typecheck && pnpm test && pnpm lint && pnpm depcruise`.

## File Structure

- **Modify** `packages/application/src/ports/validation-port.ts` — extend `ValidationCommandResult` + `RunValidationInput`.
- **Create** `packages/application/src/ports/validation-run-repository-port.ts` — `ValidationRunRepositoryPort` interface.
- **Modify** `packages/application/src/ports.ts` — re-export the new port (matches how ports are surfaced).
- **Create** `packages/application/src/run-validation.ts` — pure `RunValidation` use case.
- **Modify** `packages/application/src/index.ts` — export `run-validation.js`.
- **Modify** `packages/application/src/test-doubles/fake-validation-port.ts` — match new result shape.
- **Create** `packages/application/src/test-doubles/fake-validation-run-repository.ts` — in-memory repo for use-case tests.
- **Modify** `packages/application/src/test-doubles/index.ts` — export the fake.
- **Create** `packages/infrastructure/src/validation/validation-adapter.ts` — `ProcessValidationAdapter` + `commandSlug`.
- **Modify** `packages/infrastructure/src/index.ts` — export the adapter.
- **Modify** `apps/api/src/compose.ts` — wire adapter + use case, expose `runValidation`.

---

## Task 1: Extend the `ValidationPort` contract

**Files:**

- Modify: `packages/application/src/ports/validation-port.ts`
- Modify: `packages/application/src/test-doubles/fake-validation-port.ts`

- [ ] **Step 1: Update the port types**

Replace the contents of `packages/application/src/ports/validation-port.ts` with:

```ts
import type { ValidationCommandOutcome } from '@ai-sdlc/domain';

export interface ValidationCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  /** Captured output, kept inline for the M5-03 classifier (cheap; also written to files). */
  stdout: string;
  stderr: string;
  /** Run-directory-relative path the adapter wrote stdout to, e.g. "validate/0-build.stdout.log". */
  stdoutPath: string;
  stderrPath: string;
  outcome: ValidationCommandOutcome; // 'passed' | 'failed' | 'timed_out'
}

export interface RunValidationInput {
  cwd: string;
  commands: string[];
  timeoutSeconds: number;
  /** Absolute directory the adapter writes per-command log files into. */
  logDir: string;
  /** Prefix prepended to returned stdoutPath/stderrPath (run-relative). Default "validate". */
  logPathPrefix?: string;
}

export interface ValidationPort {
  run(input: RunValidationInput): Promise<ValidationCommandResult[]>;
}
```

- [ ] **Step 2: Update the fake to satisfy the new shape**

Replace `packages/application/src/test-doubles/fake-validation-port.ts` with:

```ts
import type {
  ValidationPort,
  RunValidationInput,
  ValidationCommandResult,
} from '../ports/validation-port.js';

export class FakeValidationPort implements ValidationPort {
  /** Tests assign scripted results here. */
  result: ValidationCommandResult[] = [];
  lastInput?: RunValidationInput;

  async run(input: RunValidationInput): Promise<ValidationCommandResult[]> {
    this.lastInput = input;
    return this.result;
  }
}
```

- [ ] **Step 3: Typecheck application**

Run: `pnpm --filter @ai-sdlc/application typecheck`
Expected: passes. If a test elsewhere constructs a `ValidationCommandResult` literal, it will now error for missing `stdoutPath`/`stderrPath`/`outcome` — fix those literals to include the new fields. (Grep: `grep -rn "ValidationCommandResult" packages apps --include="*.ts"`.)

- [ ] **Step 4: Commit**

```bash
git add packages/application/src/ports/validation-port.ts packages/application/src/test-doubles/fake-validation-port.ts
git commit -m "feat(application): extend ValidationPort with log paths + outcome (M5-02)"
```

---

## Task 2: `ValidationRunRepositoryPort` + fake

**Files:**

- Create: `packages/application/src/ports/validation-run-repository-port.ts`
- Modify: `packages/application/src/ports.ts`
- Create: `packages/application/src/test-doubles/fake-validation-run-repository.ts`
- Modify: `packages/application/src/test-doubles/index.ts`

- [ ] **Step 1: Define the port**

Create `packages/application/src/ports/validation-run-repository-port.ts`:

```ts
import type { RunId, ValidationRun } from '@ai-sdlc/domain';

/** Canonical interface; the infra ValidationRunRepository satisfies it structurally. */
export interface ValidationRunRepositoryPort {
  save(run: ValidationRun): void;
  findById(id: string): ValidationRun | null;
  listByRun(runId: RunId): ValidationRun[];
}
```

- [ ] **Step 2: Re-export it from ports.ts**

Open `packages/application/src/ports.ts`. Near the other `export type { ... } from './ports/...'` lines, add:

```ts
export type { ValidationRunRepositoryPort } from './ports/validation-run-repository-port.js';
```

- [ ] **Step 3: Create the in-memory fake**

Create `packages/application/src/test-doubles/fake-validation-run-repository.ts`:

```ts
import type { RunId, ValidationRun } from '@ai-sdlc/domain';
import type { ValidationRunRepositoryPort } from '../ports/validation-run-repository-port.js';

export class FakeValidationRunRepository implements ValidationRunRepositoryPort {
  private byId = new Map<string, ValidationRun>();

  save(run: ValidationRun): void {
    this.byId.set(run.id, run);
  }
  findById(id: string): ValidationRun | null {
    return this.byId.get(id) ?? null;
  }
  listByRun(runId: RunId): ValidationRun[] {
    return [...this.byId.values()].filter((v) => v.runId === runId);
  }
}
```

- [ ] **Step 4: Export the fake**

Open `packages/application/src/test-doubles/index.ts` and add:

```ts
export * from './fake-validation-run-repository.js';
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @ai-sdlc/application typecheck`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/application/src/ports/validation-run-repository-port.ts packages/application/src/ports.ts packages/application/src/test-doubles/fake-validation-run-repository.ts packages/application/src/test-doubles/index.ts
git commit -m "feat(application): add ValidationRunRepositoryPort + fake (M5-02)"
```

---

## Task 3: `RunValidation` use case (pure)

**Files:**

- Create: `packages/application/src/run-validation.ts`
- Modify: `packages/application/src/index.ts`
- Test: `packages/application/src/__tests__/run-validation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/application/src/__tests__/run-validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RunId, PhaseName } from '@ai-sdlc/domain';
import { RunValidation } from '../run-validation.js';
import { FakeValidationPort } from '../test-doubles/fake-validation-port.js';
import { FakeValidationRunRepository } from '../test-doubles/fake-validation-run-repository.js';

const RUN = RunId('44444444-4444-4444-4444-444444444444');

function makeUseCase(port: FakeValidationPort, repo: FakeValidationRunRepository) {
  let n = 0;
  return new RunValidation({
    validation: port,
    validationRunRepository: repo,
    idFactory: () => `vrun-${++n}`,
    now: () => new Date('2026-05-28T12:00:00Z'),
  });
}

describe('RunValidation', () => {
  it('persists a ValidationRun with one record per command, preserving order', async () => {
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
        stderr: 'boom',
        stdoutPath: 'validate/1-typecheck.stdout.log',
        stderrPath: 'validate/1-typecheck.stderr.log',
        outcome: 'failed',
      },
    ];
    const repo = new FakeValidationRunRepository();
    const useCase = makeUseCase(port, repo);

    const out = await useCase.execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/work',
      logDir: '/work/.ai-runs/x/validate',
      commands: ['pnpm build', 'pnpm typecheck'],
      timeoutSeconds: 300,
    });

    expect(out.passed).toBe(false);
    expect(out.validationRun.commands.map((c) => c.command)).toEqual([
      'pnpm build',
      'pnpm typecheck',
    ]);
    expect(out.validationRun.commands[1].outcome).toBe('failed');
    expect(out.validationRun.commands[0].kind).toBeUndefined(); // M5-03 sets this
    const persisted = repo.findById('vrun-1');
    expect(persisted).not.toBeNull();
    expect(persisted!.commands).toHaveLength(2);
    expect(persisted!.completedAt).toBeDefined();
  });

  it('passes when every command passed', async () => {
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
    const out = await makeUseCase(port, repo).execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/work',
      logDir: '/d',
      commands: ['pnpm build'],
      timeoutSeconds: 300,
    });
    expect(out.passed).toBe(true);
  });

  it('throws on an empty command list', async () => {
    const port = new FakeValidationPort();
    const repo = new FakeValidationRunRepository();
    await expect(
      makeUseCase(port, repo).execute({
        runId: RUN,
        phaseId: PhaseName('validate'),
        cwd: '/work',
        logDir: '/d',
        commands: [],
        timeoutSeconds: 300,
      }),
    ).rejects.toThrow(/no validation commands/i);
  });

  it('forwards logDir/cwd/timeout to the port', async () => {
    const port = new FakeValidationPort();
    port.result = [
      {
        command: 'pnpm build',
        exitCode: 0,
        durationMs: 1,
        stdout: '',
        stderr: '',
        stdoutPath: 'validate/0-build.stdout.log',
        stderrPath: 'validate/0-build.stderr.log',
        outcome: 'passed',
      },
    ];
    const repo = new FakeValidationRunRepository();
    await makeUseCase(port, repo).execute({
      runId: RUN,
      phaseId: PhaseName('validate'),
      cwd: '/work',
      logDir: '/abs/validate',
      commands: ['pnpm build'],
      timeoutSeconds: 120,
    });
    expect(port.lastInput).toMatchObject({
      cwd: '/work',
      logDir: '/abs/validate',
      timeoutSeconds: 120,
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/application/src/__tests__/run-validation.test.ts`
Expected: FAIL — cannot resolve `../run-validation.js`.

- [ ] **Step 3: Implement the use case**

Create `packages/application/src/run-validation.ts`:

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

export interface RunValidationDeps {
  validation: ValidationPort;
  validationRunRepository: ValidationRunRepositoryPort;
  idFactory: () => string;
  now: () => Date;
}

export interface RunValidationInputUC {
  runId: RunId;
  phaseId: PhaseName;
  cwd: string;
  logDir: string;
  commands: string[];
  timeoutSeconds: number;
  logPathPrefix?: string;
}

export interface RunValidationOutput {
  validationRun: ValidationRun;
  passed: boolean;
}

export class RunValidation {
  constructor(private readonly deps: RunValidationDeps) {}

  async execute(input: RunValidationInputUC): Promise<RunValidationOutput> {
    if (input.commands.length === 0) {
      throw new Error('no validation commands configured (validation.commands is empty)');
    }
    const startedAt = this.deps.now();
    const results = await this.deps.validation.run({
      cwd: input.cwd,
      commands: input.commands,
      timeoutSeconds: input.timeoutSeconds,
      logDir: input.logDir,
      ...(input.logPathPrefix ? { logPathPrefix: input.logPathPrefix } : {}),
    });

    // M5-02: kind/classifier intentionally left undefined; M5-03 fills them.
    const commands: ValidationCommandRecord[] = results.map((r) => ({
      command: r.command,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      stdoutPath: r.stdoutPath,
      stderrPath: r.stderrPath,
      outcome: r.outcome,
    }));

    const validationRun: ValidationRun = {
      id: this.deps.idFactory(),
      runId: input.runId,
      phaseId: input.phaseId,
      startedAt,
      completedAt: this.deps.now(),
      commands,
    };
    this.deps.validationRunRepository.save(validationRun);

    return { validationRun, passed: validationRunPassed(validationRun) };
  }
}
```

- [ ] **Step 4: Export from the application index**

Modify `packages/application/src/index.ts` — add:

```ts
export * from './run-validation.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/application/src/__tests__/run-validation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Verify the layer rule still holds**

Run: `pnpm depcruise`
Expected: no `application-no-io-except-prompt-template` or `application-cannot-depend-on-infrastructure` violations (the use case imports only domain + port types).

- [ ] **Step 7: Commit**

```bash
git add packages/application/src/run-validation.ts packages/application/src/index.ts packages/application/src/__tests__/run-validation.test.ts
git commit -m "feat(application): add RunValidation use case (M5-02)"
```

---

## Task 4: `ProcessValidationAdapter` (infra, runs commands + writes files)

**Files:**

- Create: `packages/infrastructure/src/validation/validation-adapter.ts`
- Modify: `packages/infrastructure/src/index.ts`
- Test: `packages/infrastructure/src/validation/__tests__/validation-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/infrastructure/src/validation/__tests__/validation-adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessValidationAdapter, commandSlug } from '../validation-adapter.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'val-adapter-'));
}

describe('commandSlug', () => {
  it('strips pnpm prefix and normalizes', () => {
    expect(commandSlug('pnpm typecheck')).toBe('typecheck');
    expect(commandSlug('pnpm test:bash')).toBe('test-bash');
    expect(commandSlug('node -e "process.exit(0)"')).toMatch(/^node/);
  });
});

describe('ProcessValidationAdapter', () => {
  it('runs every command without short-circuiting on failure', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    const results = await adapter.run({
      cwd: process.cwd(),
      commands: ['echo out; exit 0', 'echo boom >&2; exit 3', 'echo last; exit 0'],
      timeoutSeconds: 30,
      logDir,
    });
    expect(results).toHaveLength(3);
    expect(results[0].outcome).toBe('passed');
    expect(results[1].outcome).toBe('failed');
    expect(results[1].exitCode).toBe(3);
    expect(results[2].outcome).toBe('passed'); // proves no short-circuit
  });

  it('writes per-command stdout/stderr files and returns run-relative paths', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    const results = await adapter.run({
      cwd: process.cwd(),
      commands: ['echo hello; echo err >&2'],
      timeoutSeconds: 30,
      logDir,
    });
    const r = results[0];
    expect(r.stdoutPath).toBe(
      'validate/0-echo-hello-echo-err.stdout.log'.slice(0, r.stdoutPath.length),
    ); // prefix check below
    expect(r.stdoutPath.startsWith('validate/0-')).toBe(true);
    expect(r.stderrPath.startsWith('validate/0-')).toBe(true);
    // absolute files exist under logDir with matching basenames
    const stdoutAbs = join(logDir, r.stdoutPath.replace(/^validate\//, ''));
    const stderrAbs = join(logDir, r.stderrPath.replace(/^validate\//, ''));
    expect(existsSync(stdoutAbs)).toBe(true);
    expect(readFileSync(stdoutAbs, 'utf-8')).toContain('hello');
    expect(readFileSync(stderrAbs, 'utf-8')).toContain('err');
  });

  it('marks a command that exceeds the timeout as timed_out', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    const results = await adapter.run({
      cwd: process.cwd(),
      commands: ['sleep 5'],
      timeoutSeconds: 1,
      logDir,
    });
    expect(results[0].outcome).toBe('timed_out');
  });

  it('writes a validation-result.json summary', async () => {
    const logDir = freshDir();
    const adapter = new ProcessValidationAdapter();
    await adapter.run({
      cwd: process.cwd(),
      commands: ['exit 0', 'exit 1'],
      timeoutSeconds: 30,
      logDir,
    });
    const summary = JSON.parse(readFileSync(join(logDir, 'validation-result.json'), 'utf-8'));
    expect(summary.passed).toBe(false);
    expect(summary.commands).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/infrastructure/src/validation/__tests__/validation-adapter.test.ts`
Expected: FAIL — cannot resolve `../validation-adapter.js`.

- [ ] **Step 3: Implement the adapter**

Create `packages/infrastructure/src/validation/validation-adapter.ts`:

```ts
import { execa } from 'execa';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ValidationPort,
  RunValidationInput,
  ValidationCommandResult,
} from '@ai-sdlc/application';

/** Derive a filesystem-safe slug from a command string. */
export function commandSlug(command: string): string {
  return (
    command
      .replace(/^pnpm\s+/, '')
      .replace(/^npm\s+run\s+/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'cmd'
  );
}

/**
 * Runs each configured validation command as its own process. Writes per-command
 * stdout/stderr to <logDir>/<i>-<slug>.{stdout,stderr}.log and a
 * validation-result.json summary into <logDir>. Returns run-relative paths
 * (prefixed by logPathPrefix, default "validate") for persistence.
 *
 * Commands run with shell:true because entries like `pnpm test:bash` need shell
 * parsing. Commands are operator-authored config, not untrusted input.
 */
export class ProcessValidationAdapter implements ValidationPort {
  async run(input: RunValidationInput): Promise<ValidationCommandResult[]> {
    const prefix = input.logPathPrefix ?? 'validate';
    mkdirSync(input.logDir, { recursive: true });

    const results: ValidationCommandResult[] = [];
    for (let i = 0; i < input.commands.length; i++) {
      const command = input.commands[i];
      const slug = commandSlug(command);
      const stdoutRel = `${prefix}/${i}-${slug}.stdout.log`;
      const stderrRel = `${prefix}/${i}-${slug}.stderr.log`;
      const stdoutAbs = join(input.logDir, `${i}-${slug}.stdout.log`);
      const stderrAbs = join(input.logDir, `${i}-${slug}.stderr.log`);

      const started = Date.now();
      let stdout = '';
      let stderr = '';
      let exitCode = 0;
      let outcome: ValidationCommandResult['outcome'] = 'passed';
      try {
        const r = await execa(command, {
          shell: true,
          cwd: input.cwd,
          reject: false,
          all: false,
          cancelSignal: AbortSignal.timeout(input.timeoutSeconds * 1000),
        });
        stdout = r.stdout ?? '';
        stderr = r.stderr ?? '';
        exitCode = r.exitCode ?? 0;
        if (r.isCanceled) {
          outcome = 'timed_out';
          exitCode = r.exitCode ?? 124;
        } else if (exitCode !== 0) {
          outcome = 'failed';
        }
      } catch (e) {
        // execa with reject:false rarely throws; treat as failure.
        outcome = 'failed';
        exitCode = 1;
        stderr = String((e as Error).message);
      }
      const durationMs = Date.now() - started;

      writeFileSync(stdoutAbs, stdout);
      writeFileSync(stderrAbs, stderr);

      results.push({
        command,
        exitCode,
        durationMs,
        stdout,
        stderr,
        stdoutPath: stdoutRel,
        stderrPath: stderrRel,
        outcome,
      });
    }

    const passed = results.length > 0 && results.every((r) => r.outcome === 'passed');
    writeFileSync(
      join(input.logDir, 'validation-result.json'),
      JSON.stringify(
        {
          passed,
          commands: results.map((r) => ({
            command: r.command,
            exitCode: r.exitCode,
            durationMs: r.durationMs,
            outcome: r.outcome,
            stdoutPath: r.stdoutPath,
            stderrPath: r.stderrPath,
          })),
        },
        null,
        2,
      ),
    );

    return results;
  }
}
```

- [ ] **Step 4: Export from infra index**

Modify `packages/infrastructure/src/index.ts` — add:

```ts
export * from './validation/validation-adapter.js';
```

- [ ] **Step 5: Run the adapter test to verify it passes**

Run: `pnpm vitest run packages/infrastructure/src/validation/__tests__/validation-adapter.test.ts`
Expected: PASS (the `commandSlug` describe + 4 adapter tests). The `sleep 5` timeout test takes ~1s.

> If the `r.stdoutPath` prefix assertion in the test is brittle, keep only the `startsWith('validate/0-')` assertions and delete the exact-equality line — the slug for `'echo hello; echo err >&2'` is environment-stable but the exact string is not worth pinning.

- [ ] **Step 6: Commit**

```bash
git add packages/infrastructure/src/validation/validation-adapter.ts packages/infrastructure/src/index.ts packages/infrastructure/src/validation/__tests__/validation-adapter.test.ts
git commit -m "feat(infra): ProcessValidationAdapter runs commands per-process (M5-02)"
```

---

## Task 5: Wire into the composition root

**Files:**

- Modify: `apps/api/src/compose.ts`
- Test: `apps/api/src/__tests__/compose.test.ts`

- [ ] **Step 1: Add a failing assertion**

Add to `apps/api/src/__tests__/compose.test.ts`:

```ts
it('exposes runValidation use case', () => {
  const c = composeRoot({
    repoRoot: process.cwd(),
    scriptPath: '/bin/true',
    dbPath: ':memory:',
    runsDir: '/tmp/runs-test-' + Math.random(),
  });
  expect(c.runValidation).toBeDefined();
  expect(typeof c.runValidation.execute).toBe('function');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/api/src/__tests__/compose.test.ts -t "runValidation"`
Expected: FAIL — `c.runValidation` undefined.

- [ ] **Step 3: Wire it in compose.ts**

In `apps/api/src/compose.ts`:

1. Add to the `@ai-sdlc/infrastructure` import block:

```ts
  ProcessValidationAdapter,
```

2. Add to the `@ai-sdlc/application` import block:

```ts
  RunValidation,
```

3. Add `import { randomUUID } from 'node:crypto';` at the top if not already imported.
4. Add to the `Container` interface:

```ts
runValidation: RunValidation;
```

5. After `validationRunRepository` is constructed (from M5-01), add:

```ts
const validationAdapter = new ProcessValidationAdapter();
const runValidation = new RunValidation({
  validation: validationAdapter,
  validationRunRepository,
  idFactory: () => randomUUID(),
  now: () => new Date(),
});
```

6. Add to the returned object:

```ts
    runValidation,
```

- [ ] **Step 4: Run the compose test to verify it passes**

Run: `pnpm vitest run apps/api/src/__tests__/compose.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `pnpm -r build && pnpm -r typecheck && pnpm test && pnpm lint && pnpm depcruise`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/compose.ts apps/api/src/__tests__/compose.test.ts
git commit -m "feat(api): wire ProcessValidationAdapter + RunValidation into Container (M5-02)"
```

---

## Self-review checklist (run before handoff)

- [ ] Spec coverage: per-command processes ✔ (Task 4), no short-circuit ✔ (Task 4 test), per-command timeout ✔ (Task 4), persisted ValidationRun ✔ (Task 3), `validation-result.json` ✔ (Task 4), no fs in application ✔ (Task 3 + depcruise), fake updated ✔ (Task 1).
- [ ] Type consistency: `RunValidationInput` carries `logDir`/`logPathPrefix`; adapter + use case + port agree on `stdoutPath`/`stderrPath`/`outcome`; `commandSlug` name matches across file + test.
- [ ] Layer purity: `run-validation.ts` imports only `@ai-sdlc/domain` + local port types; all I/O lives in `validation-adapter.ts` (infra). Confirmed by `pnpm depcruise`.
- [ ] No placeholders.

## Out of scope (do NOT implement here)

- `kind` / `classifier` population + `Failure` emission (M5-03 — left undefined / not emitted here).
- API endpoint + UI (M5-04).
- Bash cutover + `run-validation.ts` CLI (M5-05).
