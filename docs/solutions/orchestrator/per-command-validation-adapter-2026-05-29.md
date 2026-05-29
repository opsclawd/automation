---
title: Per-command validation adapter — structured per-process command execution
date: 2026-05-29
category: orchestrator
module: packages/infrastructure
problem_type: pattern
component: validation
severity: medium
symptoms:
  - All validation commands ran inside a single { ... } > >(tee validate.log) block with merged output
  - Failing typecheck only distinguishable from failing build by grepping sentinel strings
  - No per-command timeout, artifact capture, or structured result model
root_cause: monolithic_bash_validation
resolution_type: implementation
tags:
  - validation
  - adapter
  - layer-boundary
  - port
  - compose
related_components:
  - packages/infrastructure/src/validation/validation-adapter.ts
  - packages/infrastructure/src/validation/__tests__/validation-adapter.test.ts
  - packages/application/src/ports/validation-port.ts
  - packages/application/src/ports/validation-run-repository-port.ts
  - packages/application/src/run-validation.ts
  - packages/application/src/test-doubles/fake-validation-port.ts
  - packages/application/src/test-doubles/fake-validation-run-repository.ts
  - packages/application/src/__tests__/run-validation.test.ts
  - apps/api/src/compose.ts
---

# Per-Command Validation Adapter — Structured Per-Process Execution

## Problem

The legacy Bash `validate` phase ran all commands (`pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:bash`) inside a single `{ ... } > >(tee validate.log)` block. A failing typecheck was only distinguishable from a failing build by grepping sentinel strings from the merged output. There was no per-command timeout, no per-command log file isolation, and no structured result model. This made debugging slower and prevented the orchestrator from reasoning about validation results programmatically.

## Solution: Two-Layer Architecture

A `ProcessValidationAdapter` in `packages/infrastructure` (owns all file I/O and `execa` execution) implements an extended `ValidationPort`. A pure `RunValidation` use case in `packages/application` orchestrates the port + persistence with **zero** `node:fs`/`node:path`/`execa` imports. The composition root in `apps/api/src/compose.ts` wires them together.

### Data Flow

```
compose.ts
  └── runValidation.execute({ runId, phaseId, cwd, logDir, commands, timeoutSeconds })
        │
        ├── validation.run({ cwd, commands, timeoutSeconds, logDir })
        │     └── For each command (sequentially, no short-circuit):
        │           ├── execa(command, { shell:true, cwd, reject:false, cancelSignal: AbortSignal.timeout(...) })
        │           ├── Determine outcome: timed_out (isCanceled) / failed (exitCode !== 0) / passed
        │           ├── Write stdout → logDir/<i>-<slug>.stdout.log
        │           ├── Write stderr → logDir/<i>-<slug>.stderr.log
        │           └── Return ValidationCommandResult (inline strings + paths + outcome + durationMs)
        │     └── Write validation-result.json → logDir/
        │
        ├── Map results → ValidationCommandRecord[] (domain type; kind/classifier undefined)
        ├── Build ValidationRun { id, runId, phaseId, startedAt, completedAt, commands }
        ├── validationRunRepository.save(validationRun)
        └── Return { validationRun, passed }
```

## Key Implementation Decisions

### D1: Extend `ValidationPort` (not create a new one)

The existing transient `ValidationPort` interface in `packages/application/src/ports/validation-port.ts` had no consumers outside its test double. We extended it with `stdoutPath`, `stderrPath`, `outcome`, `logDir`, and `logPathPrefix` rather than creating a new, parallel port interface.

`packages/application/src/ports/validation-port.ts`:
```typescript
import type { ValidationCommandOutcome } from '@ai-sdlc/domain';

export interface ValidationCommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutPath: string;    // run-relative, e.g. "validate/0-build.stdout.log"
  stderrPath: string;    // run-relative, e.g. "validate/0-build.stderr.log"
  outcome: ValidationCommandOutcome;
}

export interface RunValidationInput {
  cwd: string;
  commands: string[];
  timeoutSeconds: number;
  logDir: string;          // absolute path for file writing
  logPathPrefix?: string;  // defaults to "validate"
}
```

**Rationale:** The adapter needs an absolute path internally (to write files), but the persisted `ValidationCommandRecord` only stores the run-relative path. The `logPathPrefix` defaults to `"validate"` so paths look like `validate/0-build.stdout.log` — matching the run directory convention. Keeping inline `stdout`/`stderr` strings on the result is intentionally cheap (typical validation output is bounded) and lets the M5-03 classifier read the tail without a second disk read.

### D2: `ValidationRunRepositoryPort` in application, not domain

Created `packages/application/src/ports/validation-run-repository-port.ts`:
```typescript
import type { RunId, ValidationRun } from '@ai-sdlc/domain';

export interface ValidationRunRepositoryPort {
  save(run: ValidationRun): void;
  findById(id: string): ValidationRun | null;
  listByRun(runId: RunId): ValidationRun[];
}
```

**Rationale:** Follows the existing pattern (`AgentInvocationPort`, `RunRepositoryPort`). The application use case depends on the port, not the concrete `ValidationRunRepository` in `@ai-sdlc/infrastructure`. Tests use `FakeValidationRunRepository` — an in-memory `Map<string, ValidationRun>`.

### D3: Sequential execution, no parallelism

Commands run in config order, one at a time. No short-circuit on failure.

**Rationale:** `pnpm build` may be a prerequisite for `pnpm test`. Parallel execution would require dependency analysis that doesn't exist. More importantly, failing commands **must not** block subsequent commands — a failing build still needs lint/typecheck/test results so operators see the full picture. The adapter achieves this by continuing the `for` loop after a failed command.

### D4: `shell: true` for command execution

```typescript
const r = await execa(command, {
  shell: true,
  cwd: input.cwd,
  reject: false,
  all: false,
  cancelSignal: AbortSignal.timeout(input.timeoutSeconds * 1000),
});
```

**Rationale:** Config entries contain colons (`pnpm test:bash`) and future entries may contain `&&` chains. Shell parsing handles all of these. Commands are operator-authored config (`.ai-orchestrator.json`), not untrusted user input — this trust boundary is documented.

**Trade-off:** `shell: true` has security implications if commands ever come from user input. They currently don't and the architecture ensures they don't.

### D5: `validation-result.json` written by the adapter

The adapter writes `validation-result.json` into `logDir/` after all commands complete, not the use case. This keeps file I/O in the infrastructure layer.

Shape:
```json
{
  "passed": false,
  "commands": [
    {"command": "pnpm build", "exitCode": 0, "durationMs": 5200, "outcome": "passed", "stdoutPath": "validate/0-build.stdout.log", "stderrPath": "validate/0-build.stderr.log"},
    {"command": "pnpm typecheck", "exitCode": 1, "durationMs": 900, "outcome": "failed", "stdoutPath": "validate/1-typecheck.stdout.log", "stderrPath": "validate/1-typecheck.stderr.log"}
  ]
}
```

This JSON artifact is what M5-05's Bash cutover reads for pass/fail decisions. The `passed` field is computed as `results.length > 0 && results.every(r => r.outcome === 'passed')`.

### D6: Injected impurities (`idFactory`, `now`)

```typescript
export class RunValidation {
  constructor(private readonly deps: RunValidationDeps) {}

  async execute(input: RunValidationInputUC): Promise<RunValidationOutput> {
    // ...
    const validationRun: ValidationRun = {
      id: this.deps.idFactory(),
      runId: input.runId,
      phaseId: input.phaseId,
      startedAt: this.deps.now(),
      completedAt: this.deps.now(),
      commands,
    };
    // ...
  }
}
```

In production, `idFactory: () => randomUUID()` and `now: () => new Date()`. In tests, deterministic fixed values. Mirrors the `AgentRuntimeRouter` pattern.

### D7: `commandSlug` helper

Exported separately for testing, not a private function:

`packages/infrastructure/src/validation/validation-adapter.ts`:
```typescript
export function commandSlug(command: string): string {
  return (
    command
      .replace(/^pnpm\s+/, '')       // strip pnpm prefix
      .replace(/^npm\s+run\s+/, '')  // strip npm run prefix
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')   // normalize non-alphanumerics to hyphens
      .replace(/^-+|-+$/g, '')       // trim leading/trailing hyphens
      .slice(0, 40) || 'cmd'         // truncate, fallback
  );
}
```

The 0-based index prefix (`0-build`, `1-lint`, `2-typecheck`) prevents actual filesystem collisions when two distinct commands produce the same slug (e.g., `pnpm test` and `npm run test` both slug to `test`).

## Gotchas, Pitfalls, and Lessons Learned

### 1. `execa` timeout behavior with `reject: false`

With `reject: false`, a timed-out command sets `r.isCanceled = true` rather than throwing. The adapter must check `r.isCanceled` **before** checking `exitCode`:

```typescript
if (r.isCanceled) {
  outcome = 'timed_out';
  exitCode = r.exitCode ?? 124;  // conventional timeout exit code
} else if (exitCode !== 0) {
  outcome = 'failed';
}
```

The try/catch exists because `execa` **can** throw despite `reject: false` — for example when the command doesn't exist or `shell: true` rejects. The catch block handles this case by setting `outcome: 'failed'` with `exitCode: 1`.

### 2. Test temp directory cleanup pattern

The adapter test (`packages/infrastructure/src/validation/__tests__/validation-adapter.test.ts`) creates `mkdtempSync` directories and cleans them up in an `afterEach` hook via a shared `tempDirs` array. This is a pattern also used in `compose.test.ts` and should be replicated by any new integration test that creates temp directories.

### 3. `logDir` vs `logPathPrefix` dual-path scheme

The adapter receives an absolute `logDir` to write files, but returns run-relative `stdoutPath`/`stderrPath` for persistence. The `logPathPrefix` (defaults to `"validate"`) is the run-relative prefix.

```typescript
// Internal absolute path for writing
const stdoutAbs = join(input.logDir, `${i}-${slug}.stdout.log`);
writeFileSync(stdoutAbs, stdout);

// Run-relative path returned to caller (for persistence in ValidationCommandRecord)
const stdoutRel = `${prefix}/${i}-${slug}.stdout.log`;  // e.g. "validate/0-build.stdout.log"
```

Consumers reconstruct the absolute path by joining `<runRoot>/<stdoutPath>`. The test demonstrates this:

```typescript
const stdoutAbs = join(logDir, r.stdoutPath.replace(/^validate\//, ''));
```

### 4. Empty command list guard

The `RunValidation` use case throws a typed error if `commands.length === 0`. The config schema guarantees at least one command, but the guard is a defensive assertion that makes the failure mode explicit rather than a cryptic downstream error.

### 5. The class does NOT implement `RunValidationUseCase`

The planned pipeline's `RunValidationUseCase` interface (in `use-cases.ts`) has signature `execute({ runId }): Promise<{ ok: boolean }>` — deliberately narrower. The concrete `RunValidation` class has a richer signature carrying `phaseId`, `cwd`, `logDir`, `commands`, `timeoutSeconds`. The comment in `run-validation.ts:36-42` documents this gap: **M5-05** is the bridge that will map the narrow interface to this rich implementation or update the interface to match.

### 6. No `fs`/`child_process`/`execa` in application — verified by depcruise

The `RunValidation` use case imports only `@ai-sdlc/domain` (types) and local port types. It has zero I/O. This is enforced by `pnpm depcruise` — specifically the `application-no-io-except-prompt-template` rule in `.dependency-cruiser.cjs`. Adding a `node:fs` import to `packages/application/src/run-validation.ts` would fail CI.

To add a test for this: `packages/application/src/__tests__/run-validation.test.ts` imports only vitest, domain types, and local fakes — no `node:fs` or `@ai-sdlc/infrastructure`.

### 7. Adapter inline stdout/stderr vs persisted paths

The adapter returns both inline strings (`stdout`, `stderr`) and file paths (`stdoutPath`, `stderrPath`) on each `ValidationCommandResult`. The `RunValidation` use case maps to `ValidationCommandRecord[]` (the domain persisted type) which only stores paths. The inline strings are consumed upstream (M5-03 classifier reads the tail).

## File Inventory

| File | Purpose |
|------|---------|
| `packages/application/src/ports/validation-port.ts` | Extended port with `stdoutPath`, `stderrPath`, `outcome`, `logDir`, `logPathPrefix` |
| `packages/application/src/ports/validation-run-repository-port.ts` | Canonical port for `ValidationRun` persistence |
| `packages/application/src/ports.ts` | Re-exports `ValidationRunRepositoryPort` |
| `packages/application/src/run-validation.ts` | Pure use case orchestrating port + persistence |
| `packages/application/src/index.ts` | Re-exports `run-validation.js` |
| `packages/application/src/test-doubles/fake-validation-port.ts` | Updated to return new result shape |
| `packages/application/src/test-doubles/fake-validation-run-repository.ts` | In-memory `Map`-backed repository |
| `packages/application/src/test-doubles/index.ts` | Exports `FakeValidationRunRepository` |
| `packages/application/src/__tests__/run-validation.test.ts` | 4 tests: persist, pass, empty-guard, forward |
| `packages/infrastructure/src/validation/validation-adapter.ts` | `ProcessValidationAdapter` + `commandSlug` |
| `packages/infrastructure/src/validation/__tests__/validation-adapter.test.ts` | 6 tests: 2 slug + 4 adapter (no-short-circuit, file writing, timeout, summary) |
| `packages/infrastructure/src/index.ts` | Exports `validation-adapter.js` |
| `apps/api/src/compose.ts` | Wires `ProcessValidationAdapter` + `RunValidation`, exposes on `Container` |
| `apps/api/src/__tests__/compose.test.ts` | Asserts `runValidation.execute` is a function |

## Related

- Issue #134 — M5-02 story
- M5-01 (#133) — domain model (`ValidationRun`, `ValidationCommandRecord`, `validationRunPassed`, `ValidationCommandOutcome`) and `ValidationRunRepository`
- M5-03 — failure classification (reads inline `stdout`/`stderr` from `ValidationCommandResult`)
- `docs/solutions/orchestrator/port-injection-pattern-2026-05-18.md` — layer boundary conventions followed here
