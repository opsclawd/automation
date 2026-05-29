# M5-01: Validation Domain + DB Table — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted `ValidationRun` domain model (parent + per-command child records) plus a SQLite table and repository, so later M5 stories can store and read structured validation results instead of grepping one `validate.log`.

**Architecture:** A pure domain module in `packages/domain` (no I/O), a SQLite migration (version 5) + repository in `packages/infrastructure` mirroring the existing `agent_invocations` pattern, and registration on the API composition-root `Container`. This story produces and persists the data shape only; running commands (M5-02), classification (M5-03), UI (M5-04), and the Bash cutover (M5-05) come later.

**Tech Stack:** TypeScript (strict, ESM), Vitest, `better-sqlite3` (synchronous), pnpm workspaces.

---

## Background the engineer needs

- **Branded IDs.** `packages/domain/src/ids.ts` exports brand types + constructor functions, e.g. `RunId(v: string): RunId` and `PhaseName(v: string): PhaseName`. Use the constructors when building domain objects from DB rows. They throw on empty strings.
- **Existing sibling to copy.** The `agent_invocations` feature is the exact template:
  - migration: `packages/infrastructure/src/sqlite/migrations/0003-agent-invocations.ts`
  - migration runner: `packages/infrastructure/src/sqlite/migrations.ts`
  - repository: `packages/infrastructure/src/sqlite/agent-invocation-repository.ts`
  - migration test: `packages/infrastructure/src/sqlite/__tests__/migrations.test.ts`
- **DB type.** `packages/infrastructure/src/sqlite/database.ts` exports `type Db = Database.Database` and `openDatabase(path)`. `:memory:` works for tests. `foreign_keys = ON` is set, so `ON DELETE CASCADE` works.
- **Migration runner.** `applyMigrations(db)` reads a `MIGRATIONS` array, applies any whose `version` isn't in `schema_version`, each in a transaction. It is idempotent. To add a migration you create a file exporting `version` + `sql` and append it to the array.
- **Dates** are stored as ISO-8601 strings (`d.toISOString()`) and read back with `new Date(s)`.
- **Layer rule (important for later, harmless here):** `packages/domain` must not import `packages/application` or `packages/infrastructure`, and must not import `node:fs`/`node:child_process`. Keep `validation.ts` pure.
- **Run commands:**
  - One test file: `pnpm vitest run <path>`
  - One test by name: `pnpm vitest run <path> -t "<name>"`
  - Whole suite + checks: `pnpm -r build && pnpm -r typecheck && pnpm test && pnpm lint`

## File Structure

- **Create** `packages/domain/src/validation.ts` — pure types (`ValidationRun`, `ValidationCommandRecord`, enums) + pure helper `validationRunPassed`.
- **Modify** `packages/domain/src/index.ts` — export the new module.
- **Create** `packages/infrastructure/src/sqlite/migrations/0005-validation-results.ts` — `validation_runs` + `validation_command_results` tables.
- **Modify** `packages/infrastructure/src/sqlite/migrations.ts` — register migration 0005.
- **Create** `packages/infrastructure/src/sqlite/validation-run-repository.ts` — `ValidationRunRepository` (save/findById/listByRun).
- **Modify** `packages/infrastructure/src/index.ts` — export the repository.
- **Modify** `apps/api/src/compose.ts` — instantiate + expose `validationRunRepository` on `Container`.
- **Modify** `packages/infrastructure/src/sqlite/__tests__/cascade.test.ts` — assert cascade delete.
- **Create** tests alongside each unit.

---

## Task 1: Domain types + `validationRunPassed`

**Files:**

- Create: `packages/domain/src/validation.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/__tests__/validation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/domain/src/__tests__/validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RunId, PhaseName } from '../ids.js';
import {
  validationRunPassed,
  type ValidationRun,
  type ValidationCommandRecord,
} from '../validation.js';

function cmd(overrides: Partial<ValidationCommandRecord> = {}): ValidationCommandRecord {
  return {
    command: 'pnpm build',
    exitCode: 0,
    durationMs: 10,
    stdoutPath: 'validate/0-build.stdout.log',
    stderrPath: 'validate/0-build.stderr.log',
    outcome: 'passed',
    ...overrides,
  };
}

function run(commands: ValidationCommandRecord[]): ValidationRun {
  return {
    id: 'v-1',
    runId: RunId('11111111-1111-1111-1111-111111111111'),
    phaseId: PhaseName('validate'),
    commands,
    startedAt: new Date('2026-05-28T00:00:00Z'),
  };
}

describe('validationRunPassed', () => {
  it('is false for an empty command list', () => {
    expect(validationRunPassed(run([]))).toBe(false);
  });

  it('is true only when every command passed', () => {
    expect(validationRunPassed(run([cmd(), cmd({ command: 'pnpm test' })]))).toBe(true);
  });

  it('is false when any command failed', () => {
    expect(validationRunPassed(run([cmd(), cmd({ outcome: 'failed', exitCode: 1 })]))).toBe(false);
  });

  it('is false when any command timed out', () => {
    expect(validationRunPassed(run([cmd({ outcome: 'timed_out' })]))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/domain/src/__tests__/validation.test.ts`
Expected: FAIL — cannot resolve `../validation.js`.

- [ ] **Step 3: Implement the domain module**

Create `packages/domain/src/validation.ts`:

```ts
import type { RunId, PhaseName } from './ids.js';

export type ValidationCommandOutcome = 'passed' | 'failed' | 'timed_out';

/** Categorization of a command, inferred from its command string (set in M5-03). */
export type ValidationCommandKind = 'build' | 'lint' | 'typecheck' | 'test' | 'other';

/**
 * A persisted per-command result. Large output lives on disk; we store
 * run-directory-relative paths (e.g. "validate/2-typecheck.stdout.log").
 *
 * NOTE: distinct from the transient `ValidationCommandResult` in
 * packages/application/src/ports/validation-port.ts, which carries inline
 * stdout/stderr strings as the adapter return shape. This is the *persisted*
 * record. M5-02 maps the former into the latter.
 */
export interface ValidationCommandRecord {
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  outcome: ValidationCommandOutcome;
  kind?: ValidationCommandKind; // undefined until M5-03 classifies
  classifier?: string; // short failure summary; set by M5-03 for non-passed commands
}

export interface ValidationRun {
  id: string; // UUID
  runId: RunId;
  phaseId: PhaseName; // "validate"
  commands: ValidationCommandRecord[];
  startedAt: Date;
  completedAt?: Date;
}

/**
 * A ValidationRun passes iff it has at least one command and every command
 * passed. An empty command list is NOT a pass (surface as a config error
 * upstream in M5-02).
 */
export function validationRunPassed(v: ValidationRun): boolean {
  return v.commands.length > 0 && v.commands.every((c) => c.outcome === 'passed');
}
```

- [ ] **Step 4: Export from the domain index**

Modify `packages/domain/src/index.ts` — add this line after the other `export *` lines:

```ts
export * from './validation.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/domain/src/__tests__/validation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck the domain package**

Run: `pnpm --filter @ai-sdlc/domain typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/validation.ts packages/domain/src/index.ts packages/domain/src/__tests__/validation.test.ts
git commit -m "feat(domain): add ValidationRun model + validationRunPassed (M5-01)"
```

---

## Task 2: SQLite migration 0005

**Files:**

- Create: `packages/infrastructure/src/sqlite/migrations/0005-validation-results.ts`
- Modify: `packages/infrastructure/src/sqlite/migrations.ts`
- Test: `packages/infrastructure/src/sqlite/__tests__/migrations-0005.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/infrastructure/src/sqlite/__tests__/migrations-0005.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';

describe('migration 0005 validation tables', () => {
  it('creates validation_runs with required columns', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const names = (
      db.prepare(`PRAGMA table_info('validation_runs')`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const required of ['id', 'run_uuid', 'phase_id', 'started_at', 'completed_at']) {
      expect(names).toContain(required);
    }
    db.close();
  });

  it('creates validation_command_results with required columns', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const names = (
      db.prepare(`PRAGMA table_info('validation_command_results')`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    for (const required of [
      'id',
      'validation_run_id',
      'ordinal',
      'command',
      'exit_code',
      'duration_ms',
      'stdout_path',
      'stderr_path',
      'outcome',
      'kind',
      'classifier',
    ]) {
      expect(names).toContain(required);
    }
    db.close();
  });

  it('reaches schema version 5 and is idempotent', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    applyMigrations(db);
    const versions = db.prepare('SELECT version FROM schema_version').all();
    expect(versions).toHaveLength(5);
    db.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/infrastructure/src/sqlite/__tests__/migrations-0005.test.ts`
Expected: FAIL — only 4 versions, tables missing.

- [ ] **Step 3: Create the migration file**

Create `packages/infrastructure/src/sqlite/migrations/0005-validation-results.ts`:

```ts
export const version = 5;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS validation_runs (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS validation_command_results (
  id TEXT PRIMARY KEY,
  validation_run_id TEXT NOT NULL REFERENCES validation_runs(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  stdout_path TEXT NOT NULL,
  stderr_path TEXT NOT NULL,
  outcome TEXT NOT NULL,
  kind TEXT,
  classifier TEXT
);

CREATE INDEX IF NOT EXISTS idx_validation_runs_run
  ON validation_runs (run_uuid);
CREATE INDEX IF NOT EXISTS idx_validation_cmd_results_run
  ON validation_command_results (validation_run_id, ordinal);
`;
```

- [ ] **Step 4: Register the migration**

Modify `packages/infrastructure/src/sqlite/migrations.ts`. Add the import next to the others:

```ts
import * as validationResults from './migrations/0005-validation-results.js';
```

Add to the `MIGRATIONS` array (after `phaseRename`):

```ts
  { version: validationResults.version, sql: validationResults.sql },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/infrastructure/src/sqlite/__tests__/migrations-0005.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Update the existing migrations idempotency test**

The test in `packages/infrastructure/src/sqlite/__tests__/migrations.test.ts` asserts `expect(versions).toHaveLength(4)`. Change it to `5`:

```ts
expect(versions).toHaveLength(5);
```

- [ ] **Step 7: Run the existing migration test**

Run: `pnpm vitest run packages/infrastructure/src/sqlite/__tests__/migrations.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/infrastructure/src/sqlite/migrations/0005-validation-results.ts packages/infrastructure/src/sqlite/migrations.ts packages/infrastructure/src/sqlite/__tests__/migrations-0005.test.ts packages/infrastructure/src/sqlite/__tests__/migrations.test.ts
git commit -m "feat(infra): add validation_results migration v5 (M5-01)"
```

---

## Task 3: `ValidationRunRepository`

**Files:**

- Create: `packages/infrastructure/src/sqlite/validation-run-repository.ts`
- Modify: `packages/infrastructure/src/index.ts`
- Test: `packages/infrastructure/src/sqlite/__tests__/validation-run-repository.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/infrastructure/src/sqlite/__tests__/validation-run-repository.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';
import { ValidationRunRepository } from '../validation-run-repository.js';
import { RunId, PhaseName, type ValidationRun } from '@ai-sdlc/domain';

const RUN_UUID = '22222222-2222-2222-2222-222222222222';

function seedRun(db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at, completed_phases)
     VALUES (?, 'run-x', 7, 'issue', 'running', datetime('now'), '[]')`,
  ).run(RUN_UUID);
}

function sampleRun(): ValidationRun {
  return {
    id: 'vrun-1',
    runId: RunId(RUN_UUID),
    phaseId: PhaseName('validate'),
    startedAt: new Date('2026-05-28T10:00:00Z'),
    completedAt: new Date('2026-05-28T10:01:00Z'),
    commands: [
      {
        command: 'pnpm build',
        exitCode: 0,
        durationMs: 100,
        stdoutPath: 'validate/0-build.stdout.log',
        stderrPath: 'validate/0-build.stderr.log',
        outcome: 'passed',
        kind: 'build',
      },
      {
        command: 'pnpm typecheck',
        exitCode: 2,
        durationMs: 200,
        stdoutPath: 'validate/1-typecheck.stdout.log',
        stderrPath: 'validate/1-typecheck.stderr.log',
        outcome: 'failed',
        kind: 'typecheck',
        classifier: '12 errors',
      },
    ],
  };
}

describe('ValidationRunRepository', () => {
  it('round-trips a validation run with ordered commands and nullable fields', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    seedRun(db);
    const repo = new ValidationRunRepository(db);

    repo.save(sampleRun());
    const got = repo.findById('vrun-1');

    expect(got).not.toBeNull();
    expect(got!.runId).toBe(RUN_UUID);
    expect(got!.phaseId).toBe('validate');
    expect(got!.startedAt.toISOString()).toBe('2026-05-28T10:00:00.000Z');
    expect(got!.completedAt?.toISOString()).toBe('2026-05-28T10:01:00.000Z');
    expect(got!.commands).toHaveLength(2);
    expect(got!.commands[0].command).toBe('pnpm build');
    expect(got!.commands[0].kind).toBe('build');
    expect(got!.commands[0].classifier).toBeUndefined();
    expect(got!.commands[1].outcome).toBe('failed');
    expect(got!.commands[1].classifier).toBe('12 errors');
  });

  it('listByRun returns runs for a run id', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    seedRun(db);
    const repo = new ValidationRunRepository(db);
    repo.save(sampleRun());
    const list = repo.listByRun(RunId(RUN_UUID));
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('vrun-1');
  });

  it('save is idempotent — re-saving replaces child rows', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    seedRun(db);
    const repo = new ValidationRunRepository(db);
    repo.save(sampleRun());
    const reduced = { ...sampleRun(), commands: [sampleRun().commands[0]] };
    repo.save(reduced);
    const got = repo.findById('vrun-1');
    expect(got!.commands).toHaveLength(1);
  });

  it('findById returns null for unknown id', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const repo = new ValidationRunRepository(db);
    expect(repo.findById('nope')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/infrastructure/src/sqlite/__tests__/validation-run-repository.test.ts`
Expected: FAIL — cannot resolve `../validation-run-repository.js`.

- [ ] **Step 3: Implement the repository**

Create `packages/infrastructure/src/sqlite/validation-run-repository.ts`:

```ts
import type { Db } from './database.js';
import {
  RunId,
  PhaseName,
  type ValidationRun,
  type ValidationCommandRecord,
  type ValidationCommandOutcome,
  type ValidationCommandKind,
} from '@ai-sdlc/domain';

interface RunRow {
  id: string;
  run_uuid: string;
  phase_id: string;
  started_at: string;
  completed_at: string | null;
}

interface CmdRow {
  command: string;
  exit_code: number;
  duration_ms: number;
  stdout_path: string;
  stderr_path: string;
  outcome: string;
  kind: string | null;
  classifier: string | null;
}

function rowToCommand(r: CmdRow): ValidationCommandRecord {
  return {
    command: r.command,
    exitCode: r.exit_code,
    durationMs: r.duration_ms,
    stdoutPath: r.stdout_path,
    stderrPath: r.stderr_path,
    outcome: r.outcome as ValidationCommandOutcome,
    ...(r.kind !== null ? { kind: r.kind as ValidationCommandKind } : {}),
    ...(r.classifier !== null ? { classifier: r.classifier } : {}),
  };
}

/** Implements ValidationRunRepositoryPort (@ai-sdlc/application). */
export class ValidationRunRepository {
  constructor(private readonly db: Db) {}

  save(run: ValidationRun): void {
    const tx = this.db.transaction((v: ValidationRun) => {
      this.db
        .prepare(
          `INSERT INTO validation_runs (id, run_uuid, phase_id, started_at, completed_at)
           VALUES (@id, @runUuid, @phaseId, @startedAt, @completedAt)
           ON CONFLICT(id) DO UPDATE SET
             run_uuid = excluded.run_uuid,
             phase_id = excluded.phase_id,
             started_at = excluded.started_at,
             completed_at = excluded.completed_at`,
        )
        .run({
          id: v.id,
          runUuid: v.runId,
          phaseId: v.phaseId,
          startedAt: v.startedAt.toISOString(),
          completedAt: v.completedAt?.toISOString() ?? null,
        });

      this.db
        .prepare(`DELETE FROM validation_command_results WHERE validation_run_id = ?`)
        .run(v.id);

      const insertCmd = this.db.prepare(
        `INSERT INTO validation_command_results
          (id, validation_run_id, ordinal, command, exit_code, duration_ms,
           stdout_path, stderr_path, outcome, kind, classifier)
         VALUES (@id, @validationRunId, @ordinal, @command, @exitCode, @durationMs,
           @stdoutPath, @stderrPath, @outcome, @kind, @classifier)`,
      );
      v.commands.forEach((c, ordinal) => {
        insertCmd.run({
          id: `${v.id}-${ordinal}`,
          validationRunId: v.id,
          ordinal,
          command: c.command,
          exitCode: c.exitCode,
          durationMs: c.durationMs,
          stdoutPath: c.stdoutPath,
          stderrPath: c.stderrPath,
          outcome: c.outcome,
          kind: c.kind ?? null,
          classifier: c.classifier ?? null,
        });
      });
    });
    tx(run);
  }

  findById(id: string): ValidationRun | null {
    const row = this.db.prepare(`SELECT * FROM validation_runs WHERE id = ?`).get(id) as
      | RunRow
      | undefined;
    if (!row) return null;
    return this.hydrate(row);
  }

  listByRun(runId: RunId): ValidationRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM validation_runs WHERE run_uuid = ? ORDER BY started_at ASC`)
      .all(runId) as RunRow[];
    return rows.map((r) => this.hydrate(r));
  }

  private hydrate(row: RunRow): ValidationRun {
    const cmds = this.db
      .prepare(
        `SELECT * FROM validation_command_results WHERE validation_run_id = ? ORDER BY ordinal ASC`,
      )
      .all(row.id) as CmdRow[];
    return {
      id: row.id,
      runId: RunId(row.run_uuid),
      phaseId: PhaseName(row.phase_id),
      startedAt: new Date(row.started_at),
      ...(row.completed_at !== null ? { completedAt: new Date(row.completed_at) } : {}),
      commands: cmds.map(rowToCommand),
    };
  }
}
```

- [ ] **Step 4: Export from the infrastructure index**

Modify `packages/infrastructure/src/index.ts` — add after the other sqlite exports:

```ts
export * from './sqlite/validation-run-repository.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/infrastructure/src/sqlite/__tests__/validation-run-repository.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/infrastructure/src/sqlite/validation-run-repository.ts packages/infrastructure/src/index.ts packages/infrastructure/src/sqlite/__tests__/validation-run-repository.test.ts
git commit -m "feat(infra): add ValidationRunRepository (M5-01)"
```

---

## Task 4: Cascade-delete coverage

**Files:**

- Modify/Test: `packages/infrastructure/src/sqlite/__tests__/cascade.test.ts`

- [ ] **Step 1: Read the existing cascade test**

Run: `sed -n '1,60p' packages/infrastructure/src/sqlite/__tests__/cascade.test.ts`
Note its style for inserting a run and asserting child-row deletion when the run is deleted. Match it.

- [ ] **Step 2: Add a failing test for validation cascade**

Append to `packages/infrastructure/src/sqlite/__tests__/cascade.test.ts` a test that:

1. applies migrations on a `:memory:` db,
2. inserts a `runs` row (copy the existing helper/insert in that file),
3. saves a `ValidationRun` via `ValidationRunRepository` (one command),
4. deletes the run row: `db.prepare('DELETE FROM runs WHERE uuid = ?').run(RUN_UUID)`,
5. asserts `validation_runs` and `validation_command_results` are both empty.

Use this body (adjust the run-insert to match the file's existing helper if one exists):

```ts
import { ValidationRunRepository } from '../validation-run-repository.js';
import { RunId, PhaseName } from '@ai-sdlc/domain';

it('cascades delete to validation_runs and validation_command_results', () => {
  const db = openDatabase(':memory:');
  applyMigrations(db);
  const RUN_UUID = '33333333-3333-3333-3333-333333333333';
  db.prepare(
    `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at, completed_phases)
     VALUES (?, 'run-c', 9, 'issue', 'running', datetime('now'), '[]')`,
  ).run(RUN_UUID);
  new ValidationRunRepository(db).save({
    id: 'vr-c',
    runId: RunId(RUN_UUID),
    phaseId: PhaseName('validate'),
    startedAt: new Date(),
    commands: [
      {
        command: 'pnpm build',
        exitCode: 0,
        durationMs: 1,
        stdoutPath: 'validate/0-build.stdout.log',
        stderrPath: 'validate/0-build.stderr.log',
        outcome: 'passed',
      },
    ],
  });
  db.prepare('DELETE FROM runs WHERE uuid = ?').run(RUN_UUID);
  expect(db.prepare('SELECT COUNT(*) c FROM validation_runs').get()).toEqual({ c: 0 });
  expect(db.prepare('SELECT COUNT(*) c FROM validation_command_results').get()).toEqual({ c: 0 });
  db.close();
});
```

> If `openDatabase`/`applyMigrations`/`describe`/`it`/`expect` are already imported at the top of the file, do not re-import them — only add the two `@ai-sdlc/domain` / repository imports.

- [ ] **Step 3: Run the cascade test**

Run: `pnpm vitest run packages/infrastructure/src/sqlite/__tests__/cascade.test.ts`
Expected: PASS (including the new test).

- [ ] **Step 4: Commit**

```bash
git add packages/infrastructure/src/sqlite/__tests__/cascade.test.ts
git commit -m "test(infra): validation tables cascade on run delete (M5-01)"
```

---

## Task 5: Expose `validationRunRepository` on the Container

**Files:**

- Modify: `apps/api/src/compose.ts`
- Test: `apps/api/src/__tests__/compose.test.ts`

- [ ] **Step 1: Add a failing assertion**

Open `apps/api/src/__tests__/compose.test.ts`. Add a test (match the existing compose-test style — it composes with `dbPath: ':memory:'`):

```ts
it('exposes validationRunRepository', () => {
  const c = composeRoot({
    repoRoot: process.cwd(),
    scriptPath: '/bin/true',
    dbPath: ':memory:',
    runsDir: '/tmp/runs-test-' + Math.random(),
  });
  expect(c.validationRunRepository).toBeDefined();
  expect(typeof c.validationRunRepository.listByRun).toBe('function');
});
```

If `composeRoot`/`expect`/`it` are already imported, reuse them.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/api/src/__tests__/compose.test.ts -t "validationRunRepository"`
Expected: FAIL — `c.validationRunRepository` is undefined / type error.

- [ ] **Step 3: Wire it into compose.ts**

In `apps/api/src/compose.ts`:

1. Add `ValidationRunRepository` to the existing infrastructure import block (the one importing `AgentInvocationRepository`):

```ts
  ValidationRunRepository,
```

2. Add the field to the `Container` interface (next to `agentInvocationRepository`):

```ts
validationRunRepository: ValidationRunRepository;
```

3. Instantiate it where the other repositories are constructed (next to `const agentInvocationRepository = new AgentInvocationRepository(db);`):

```ts
const validationRunRepository = new ValidationRunRepository(db);
```

4. Add it to the returned object (next to `agentInvocationRepository,`):

```ts
    validationRunRepository,
```

- [ ] **Step 4: Run the compose test to verify it passes**

Run: `pnpm vitest run apps/api/src/__tests__/compose.test.ts`
Expected: PASS.

- [ ] **Step 5: Full verification**

Run: `pnpm -r build && pnpm -r typecheck && pnpm test && pnpm lint && pnpm depcruise`
Expected: all green (depcruise: domain stays pure, no new layer violations).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/compose.ts apps/api/src/__tests__/compose.test.ts
git commit -m "feat(api): expose validationRunRepository on Container (M5-01)"
```

---

## Self-review checklist (run before handoff)

- [ ] Spec coverage: domain types ✔ (Task 1), migration ✔ (Task 2), repository round-trip + ordering + nullable kind/classifier ✔ (Task 3), cascade ✔ (Task 4), Container ✔ (Task 5), `validationRunPassed` empty-list rule ✔ (Task 1).
- [ ] Type consistency: `ValidationRun` / `ValidationCommandRecord` / `ValidationCommandOutcome` / `ValidationCommandKind` names match across domain, repository, and tests. `runId` is `RunId`, `phaseId` is `PhaseName`.
- [ ] No placeholders: every step has full code or an exact command.
- [ ] Layer purity: `packages/domain/src/validation.ts` imports only `./ids.js` (types). No fs/child_process.

## Out of scope (do NOT implement here)

- Running commands / `execa` (M5-02).
- Populating `kind` / `classifier` from real output (M5-03 — left nullable here).
- API endpoint + UI (M5-04).
- Bash cutover (M5-05).
