# Milestone 4 — Runtime-Agnostic Agent Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace direct `opencode` invocations with a runtime-agnostic `AgentPort` pipeline that records every invocation (telemetry), routes by profile, applies documented fallback triggers, validates agent contracts, and extracts results deterministically.

**Architecture:** A persistence layer (`agent_invocations` table) under the application's `AgentInvocationPort`. An infrastructure-side `AgentRuntimeRouter` (`implements AgentPort`) that dispatches to per-runtime adapters (`OpenCodeAgentAdapter`, `PiAgentAdapter`), records each invocation, and escalates to a fallback profile on observable failure. Application-side prompt rendering, contract validation, and deterministic result extraction. A new `apps/cli/run-agent` CLI that Bash scripts call so every agent invocation flows through the same pipeline.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, `better-sqlite3` (already in use), `execa` (already in use), Zod, Fastify.

---

## Cross-cutting conventions (read once before starting any story)

1. **Layer rules.** `packages/domain` is pure (no `fs`, no `child_process`, no SQLite). `packages/application` knows ports + use cases (no infra imports). `packages/infrastructure` implements ports (may use Node APIs + SQLite). `apps/api` and `apps/cli` are the composition root. Run `pnpm depcruise` before each commit.
2. **TDD.** Every task is "write failing test → run, expect fail → implement → run, expect pass → commit." Do not skip the failing-test step.
3. **Commits.** Commit after every task. Commit messages: `M4-XX(<area>): <imperative phrase>` — e.g. `M4-01(domain): add AgentInvocationId brand`. The orchestrator handles push + PR; do not push or open PRs manually inside the loop.
4. **Test framework.** Vitest, already configured everywhere. Run filtered tests with `pnpm --filter <pkg> test --run -- <relative-path>` or rely on `pnpm -r test` for the final verification.
5. **Final verification per story.** End every story with `pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm depcruise`. All must pass.
6. **Branded IDs.** Construct via the brand function (e.g. `RunId('uuid-here')`), do not cast.
7. **Migrations.** SQLite migrations live in `packages/infrastructure/src/sqlite/migrations/<NNNN>-<slug>.ts`. Use the next free number (currently `0003`). Each exports `version: number` and `sql: string`. Register in `packages/infrastructure/src/sqlite/migrations.ts`.
8. **Shared contract violation codes.** First introduced in Story M4-02 as `packages/application/src/agent/contract-violation-codes.ts`. Every later story imports from there — no duplicated string literals.
9. **Time.** Use an injected `clock: () => Date` whenever a value goes into `agent_invocations`. Tests pass a deterministic clock. Production passes `() => new Date()`.
10. **Do not modify** existing tests unless they break for a legitimate reason (e.g. a type tightening exposed a real bug). If existing tests fail after a change, treat that as a signal to revisit the change.

---

## Story M4-01 — Agent invocation model + DB tables

**GitHub issue:** #89. **Closes #50.**

### File structure

- Create: `packages/domain/src/agent-invocation.ts` — pure `AgentInvocation` type + outcome union.
- Modify: `packages/domain/src/ids.ts` — add `AgentInvocationId` brand.
- Modify: `packages/domain/src/index.ts` — re-export.
- Create: `packages/application/src/ports/agent-invocation-port.ts` — `AgentInvocationPort` interface.
- Modify: `packages/application/src/ports.ts` — re-export the port.
- Create: `packages/application/src/test-doubles/fake-agent-invocation-port.ts`.
- Modify: `packages/application/src/test-doubles/index.ts` — barrel export.
- Create: `packages/infrastructure/src/sqlite/migrations/0003-agent-invocations.ts`.
- Modify: `packages/infrastructure/src/sqlite/migrations.ts` — register migration.
- Create: `packages/infrastructure/src/sqlite/agent-invocation-repository.ts`.
- Modify: `packages/infrastructure/src/index.ts` — re-export.
- Modify: `apps/api/src/compose.ts` — register repository on `Container`.
- Modify: `apps/api/src/routes/` (add `invocations.ts` or extend `runs.ts`) + register in `server.ts`.
- Modify: `apps/api/src/port-conformance.check.ts` — add compile-time conformance for `AgentInvocationRepository` → `AgentInvocationPort`.
- Tests:
  - `packages/domain/src/__tests__/agent-invocation.test.ts`
  - `packages/application/src/__tests__/fake-agent-invocation-port.test.ts`
  - `packages/infrastructure/src/sqlite/__tests__/agent-invocation-repository.test.ts`
  - `apps/api/src/__tests__/invocations-api.test.ts`

### Task 1: AgentInvocationId brand

**Files:**

- Modify: `packages/domain/src/ids.ts`
- Test: `packages/domain/src/__tests__/ids.test.ts` (append)

- [ ] **Step 1: Write failing test** — append to `packages/domain/src/__tests__/ids.test.ts`:

```ts
import { AgentInvocationId } from '../ids.js';

describe('AgentInvocationId', () => {
  it('accepts non-empty strings', () => {
    const id = AgentInvocationId('inv-123');
    expect(id).toBe('inv-123');
  });
  it('rejects empty strings', () => {
    expect(() => AgentInvocationId('')).toThrow();
    expect(() => AgentInvocationId('   ')).toThrow();
  });
});
```

- [ ] **Step 2: Run test, expect fail**
      `pnpm --filter @ai-sdlc/domain test --run -- ids` → fail with `AgentInvocationId is not exported`.

- [ ] **Step 3: Implement** — append to `packages/domain/src/ids.ts`:

```ts
export type AgentInvocationId = string & { readonly __brand: 'AgentInvocationId' };
export function AgentInvocationId(v: string): AgentInvocationId {
  nonEmpty('AgentInvocationId', v);
  return v as AgentInvocationId;
}
```

- [ ] **Step 4: Run test, expect pass.**
- [ ] **Step 5: Commit** — `git add packages/domain && git commit -m "M4-01(domain): add AgentInvocationId brand"`.

### Task 2: AgentInvocation domain type

**Files:**

- Create: `packages/domain/src/agent-invocation.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/__tests__/agent-invocation.test.ts`

- [ ] **Step 1: Write failing test** — create `packages/domain/src/__tests__/agent-invocation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { AgentInvocation, AgentInvocationOutcome } from '../agent-invocation.js';
import { AgentInvocationId, RunId, PhaseName } from '../ids.js';
import { AgentProfileName } from '@ai-sdlc/application';

describe('AgentInvocation', () => {
  it('compiles with every field populated', () => {
    const inv: AgentInvocation = {
      id: AgentInvocationId('inv-1'),
      runId: RunId('run-1'),
      phaseId: PhaseName('plan-design'),
      stepId: 'step-1',
      profile: AgentProfileName('opencode-frontier'),
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      skill: 'plan',
      promptPath: '/tmp/prompt.md',
      promptChars: 1234,
      promptTokensApprox: 308,
      stdoutPath: '/tmp/stdout.log',
      stderrPath: '/tmp/stderr.log',
      startedAt: new Date('2026-05-22T10:00:00Z'),
      endedAt: new Date('2026-05-22T10:01:30Z'),
      startCommitSha: 'a'.repeat(40),
      endCommitSha: 'b'.repeat(40),
      exitCode: 0,
      durationMs: 90_000,
      timeoutMs: 600_000,
      outcome: 'success' satisfies AgentInvocationOutcome,
      contractViolations: [],
      resultJsonPath: '/tmp/result.json',
      fallbackOfInvocationId: undefined,
    };
    expect(inv.runtime).toBe('opencode');
  });
});
```

- [ ] **Step 2: Run test, expect fail** (`AgentInvocation` not found).

- [ ] **Step 3: Implement** — create `packages/domain/src/agent-invocation.ts`:

```ts
import type { AgentInvocationId, PhaseName, RunId } from './ids.js';
import type { AgentProfileName, AgentRuntimeKind } from '@ai-sdlc/application';

export type AgentInvocationOutcome = 'success' | 'failed' | 'timeout' | 'contract_violation';

export interface AgentInvocation {
  id: AgentInvocationId;
  runId: RunId;
  phaseId: PhaseName;
  stepId?: string;
  profile: AgentProfileName;
  runtime: AgentRuntimeKind;
  provider: string;
  model: string;
  skill?: string;
  promptPath: string;
  promptChars: number;
  promptTokensApprox?: number;
  stdoutPath: string;
  stderrPath: string;
  startedAt: Date;
  endedAt?: Date;
  startCommitSha: string;
  endCommitSha?: string;
  exitCode?: number;
  durationMs?: number;
  timeoutMs: number;
  outcome?: AgentInvocationOutcome;
  contractViolations?: string[];
  resultJsonPath?: string;
  fallbackOfInvocationId?: AgentInvocationId;
}
```

> Note: `@ai-sdlc/application` is a dependency of `@ai-sdlc/domain`? No — it is the other way around. Re-declare `AgentProfileName` and `AgentRuntimeKind` types inline in the domain file as branded re-exports? **No.** Move the type imports to `@ai-sdlc/application/agent/types` is the wrong direction.

> **Resolution:** Move `AgentRuntimeKind` and `AgentProfileName` from `@ai-sdlc/application` into `@ai-sdlc/domain` as part of this task. They are pure types; application code re-exports them via its index. This means an **extra small migration substep** below.

- [ ] **Step 3a: Move `AgentRuntimeKind` and `AgentProfileName` into domain.**
      Create `packages/domain/src/agent-types.ts`:

  ```ts
  export type AgentRuntimeKind = 'opencode' | 'pi';

  export type AgentProfileName = string & { readonly __brand: 'AgentProfileName' };
  export function AgentProfileName(v: string): AgentProfileName {
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new Error('AgentProfileName must be a non-empty string');
    }
    return v as AgentProfileName;
  }
  ```

  Append to `packages/domain/src/index.ts`:

  ```ts
  export * from './agent-types.js';
  export * from './agent-invocation.js';
  ```

  In `packages/application/src/agent/types.ts`, replace the inline `AgentRuntimeKind` and `AgentProfileName` definitions with:

  ```ts
  export { AgentProfileName, type AgentRuntimeKind } from '@ai-sdlc/domain';
  ```

  Keep the rest of `types.ts` (`AgentProfile`, `isOpencodeProfile`, etc.) where it is.

- [ ] **Step 3b: Update the domain import in `agent-invocation.ts`:**

  ```ts
  import type { AgentInvocationId, PhaseName, RunId } from './ids.js';
  import type { AgentProfileName, AgentRuntimeKind } from './agent-types.js';
  ```

- [ ] **Step 4: Run test, expect pass.** Also run `pnpm -r typecheck` — application code must still build.
- [ ] **Step 5: Commit** — `git add packages/domain packages/application && git commit -m "M4-01(domain): add AgentInvocation type; move AgentRuntimeKind into domain"`.

### Task 3: AgentInvocationPort

**Files:**

- Create: `packages/application/src/ports/agent-invocation-port.ts`
- Modify: `packages/application/src/ports.ts`

- [ ] **Step 1: Create the port** — `packages/application/src/ports/agent-invocation-port.ts`:

```ts
import type {
  AgentInvocation,
  AgentInvocationId,
  AgentRuntimeKind,
  PhaseName,
  RunId,
} from '@ai-sdlc/domain';

export interface AgentInvocationUpdatePatch {
  endedAt?: Date;
  endCommitSha?: string;
  exitCode?: number;
  durationMs?: number;
  outcome?: AgentInvocation['outcome'];
  contractViolations?: string[];
  resultJsonPath?: string;
  stdoutPath?: string;
  stderrPath?: string;
}

export interface AgentInvocationPort {
  insert(invocation: AgentInvocation): void;
  update(id: AgentInvocationId, patch: AgentInvocationUpdatePatch): void;
  findById(id: AgentInvocationId): AgentInvocation | undefined;
  listByRun(runId: RunId): AgentInvocation[];
  listByRunAndPhase(runId: RunId, phaseId: PhaseName): AgentInvocation[];
  listByRuntime(runtime: AgentRuntimeKind): AgentInvocation[];
}
```

- [ ] **Step 2: Re-export** — append to `packages/application/src/ports.ts`:

```ts
export type {
  AgentInvocationPort,
  AgentInvocationUpdatePatch,
} from './ports/agent-invocation-port.js';
```

- [ ] **Step 3: Typecheck** — `pnpm -r typecheck`.
- [ ] **Step 4: Commit** — `git add packages/application && git commit -m "M4-01(application): add AgentInvocationPort"`.

### Task 4: FakeAgentInvocationPort

**Files:**

- Create: `packages/application/src/test-doubles/fake-agent-invocation-port.ts`
- Modify: `packages/application/src/test-doubles/index.ts`
- Test: `packages/application/src/__tests__/fake-agent-invocation-port.test.ts`

- [ ] **Step 1: Write failing test** — create `packages/application/src/__tests__/fake-agent-invocation-port.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  AgentInvocationId,
  AgentProfileName,
  PhaseName,
  RunId,
  type AgentInvocation,
} from '@ai-sdlc/domain';
import { FakeAgentInvocationPort } from '../test-doubles/fake-agent-invocation-port.js';

function sample(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    id: AgentInvocationId('inv-' + Math.random().toString(36).slice(2)),
    runId: RunId('run-1'),
    phaseId: PhaseName('plan-design'),
    profile: AgentProfileName('p1'),
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'm',
    promptPath: '/p',
    promptChars: 1,
    stdoutPath: '/s',
    stderrPath: '/e',
    startedAt: new Date(),
    startCommitSha: 'a'.repeat(40),
    timeoutMs: 1000,
    ...overrides,
  };
}

describe('FakeAgentInvocationPort', () => {
  it('inserts and finds by id', () => {
    const port = new FakeAgentInvocationPort();
    const inv = sample();
    port.insert(inv);
    expect(port.findById(inv.id)).toEqual(inv);
  });
  it('updates by id', () => {
    const port = new FakeAgentInvocationPort();
    const inv = sample();
    port.insert(inv);
    port.update(inv.id, { outcome: 'success', exitCode: 0, durationMs: 1000 });
    const got = port.findById(inv.id);
    expect(got?.outcome).toBe('success');
    expect(got?.exitCode).toBe(0);
  });
  it('lists by run', () => {
    const port = new FakeAgentInvocationPort();
    port.insert(sample({ id: AgentInvocationId('a'), runId: RunId('r1') }));
    port.insert(sample({ id: AgentInvocationId('b'), runId: RunId('r1') }));
    port.insert(sample({ id: AgentInvocationId('c'), runId: RunId('r2') }));
    expect(port.listByRun(RunId('r1')).map((i) => i.id)).toEqual(['a', 'b']);
  });
  it('lists by run and phase', () => {
    const port = new FakeAgentInvocationPort();
    port.insert(sample({ id: AgentInvocationId('a'), phaseId: PhaseName('p1') }));
    port.insert(sample({ id: AgentInvocationId('b'), phaseId: PhaseName('p2') }));
    expect(port.listByRunAndPhase(RunId('run-1'), PhaseName('p1')).map((i) => i.id)).toEqual(['a']);
  });
  it('lists by runtime', () => {
    const port = new FakeAgentInvocationPort();
    port.insert(sample({ id: AgentInvocationId('a'), runtime: 'opencode' }));
    port.insert(sample({ id: AgentInvocationId('b'), runtime: 'pi' }));
    expect(port.listByRuntime('pi').map((i) => i.id)).toEqual(['b']);
  });
  it('update throws on unknown id', () => {
    const port = new FakeAgentInvocationPort();
    expect(() => port.update(AgentInvocationId('missing'), {})).toThrow();
  });
});
```

- [ ] **Step 2: Run test, expect fail.**

- [ ] **Step 3: Implement** — `packages/application/src/test-doubles/fake-agent-invocation-port.ts`:

```ts
import type {
  AgentInvocation,
  AgentInvocationId,
  AgentRuntimeKind,
  PhaseName,
  RunId,
} from '@ai-sdlc/domain';
import type {
  AgentInvocationPort,
  AgentInvocationUpdatePatch,
} from '../ports/agent-invocation-port.js';

export class FakeAgentInvocationPort implements AgentInvocationPort {
  private readonly rows: AgentInvocation[] = [];

  insert(invocation: AgentInvocation): void {
    this.rows.push({ ...invocation });
  }

  update(id: AgentInvocationId, patch: AgentInvocationUpdatePatch): void {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx < 0) throw new Error(`AgentInvocation ${id} not found`);
    this.rows[idx] = { ...this.rows[idx], ...patch };
  }

  findById(id: AgentInvocationId): AgentInvocation | undefined {
    const row = this.rows.find((r) => r.id === id);
    return row ? { ...row } : undefined;
  }

  listByRun(runId: RunId): AgentInvocation[] {
    return this.rows.filter((r) => r.runId === runId).map((r) => ({ ...r }));
  }

  listByRunAndPhase(runId: RunId, phaseId: PhaseName): AgentInvocation[] {
    return this.rows
      .filter((r) => r.runId === runId && r.phaseId === phaseId)
      .map((r) => ({ ...r }));
  }

  listByRuntime(runtime: AgentRuntimeKind): AgentInvocation[] {
    return this.rows.filter((r) => r.runtime === runtime).map((r) => ({ ...r }));
  }
}
```

- [ ] **Step 4: Export from barrel** — append to `packages/application/src/test-doubles/index.ts`:

```ts
export * from './fake-agent-invocation-port.js';
```

- [ ] **Step 5: Run tests, expect pass.**
- [ ] **Step 6: Commit** — `git add packages/application && git commit -m "M4-01(application): add FakeAgentInvocationPort"`.

### Task 5: SQLite migration

**Files:**

- Create: `packages/infrastructure/src/sqlite/migrations/0003-agent-invocations.ts`
- Modify: `packages/infrastructure/src/sqlite/migrations.ts`
- Test: `packages/infrastructure/src/sqlite/__tests__/migrations.test.ts` (extend)

- [ ] **Step 1: Create migration** — `packages/infrastructure/src/sqlite/migrations/0003-agent-invocations.ts`:

```ts
export const version = 3;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS agent_invocations (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase_id TEXT NOT NULL,
  step_id TEXT,
  profile TEXT NOT NULL,
  runtime TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  skill TEXT,
  prompt_path TEXT NOT NULL,
  prompt_chars INTEGER NOT NULL,
  prompt_tokens_approx INTEGER,
  stdout_path TEXT NOT NULL,
  stderr_path TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  start_commit_sha TEXT NOT NULL,
  end_commit_sha TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  timeout_ms INTEGER NOT NULL,
  outcome TEXT,
  contract_violations TEXT NOT NULL DEFAULT '[]',
  result_json_path TEXT,
  fallback_of_invocation_id TEXT REFERENCES agent_invocations(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_invocations_run_phase
  ON agent_invocations (run_uuid, phase_id);
CREATE INDEX IF NOT EXISTS idx_agent_invocations_fallback_of
  ON agent_invocations (fallback_of_invocation_id);
`;
```

- [ ] **Step 2: Register** — modify `packages/infrastructure/src/sqlite/migrations.ts`:

```ts
import * as agentInvocations from './migrations/0003-agent-invocations.js';

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: init.version, sql: init.sql },
  { version: addPid.version, sql: addPid.sql },
  { version: agentInvocations.version, sql: agentInvocations.sql },
];
```

- [ ] **Step 3: Test migration applies cleanly** — create or append to `packages/infrastructure/src/sqlite/__tests__/migrations.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { openDatabase, applyMigrations } from '../index.js';

describe('migrations', () => {
  it('creates agent_invocations table with required columns', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const cols = db.prepare(`PRAGMA table_info('agent_invocations')`).all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    for (const required of [
      'id',
      'run_uuid',
      'phase_id',
      'profile',
      'runtime',
      'provider',
      'model',
      'prompt_chars',
      'started_at',
      'ended_at',
      'timeout_ms',
      'outcome',
      'contract_violations',
      'fallback_of_invocation_id',
    ]) {
      expect(names).toContain(required);
    }
  });
});
```

- [ ] **Step 4: Run test, expect pass.**
- [ ] **Step 5: Commit** — `git add packages/infrastructure && git commit -m "M4-01(infrastructure): add agent_invocations migration"`.

### Task 6: AgentInvocationRepository

**Files:**

- Create: `packages/infrastructure/src/sqlite/agent-invocation-repository.ts`
- Modify: `packages/infrastructure/src/index.ts`
- Test: `packages/infrastructure/src/sqlite/__tests__/agent-invocation-repository.test.ts`

- [ ] **Step 1: Write failing test:**

```ts
import { describe, it, expect } from 'vitest';
import {
  AgentInvocationId,
  AgentProfileName,
  PhaseName,
  RunId,
  type AgentInvocation,
} from '@ai-sdlc/domain';
import { openDatabase, applyMigrations, RunRepository } from '../../index.js';
import { AgentInvocationRepository } from '../agent-invocation-repository.js';

function sample(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    id: AgentInvocationId('inv-1'),
    runId: RunId('00000000-0000-0000-0000-000000000001'),
    phaseId: PhaseName('plan-design'),
    stepId: 'step-1',
    profile: AgentProfileName('opencode-frontier'),
    runtime: 'opencode',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    skill: 'plan',
    promptPath: '/tmp/prompt.md',
    promptChars: 1234,
    promptTokensApprox: 308,
    stdoutPath: '/tmp/stdout.log',
    stderrPath: '/tmp/stderr.log',
    startedAt: new Date('2026-05-22T10:00:00.000Z'),
    endedAt: new Date('2026-05-22T10:01:30.000Z'),
    startCommitSha: 'a'.repeat(40),
    endCommitSha: 'b'.repeat(40),
    exitCode: 0,
    durationMs: 90_000,
    timeoutMs: 600_000,
    outcome: 'success',
    contractViolations: ['x_violation', 'y_violation'],
    resultJsonPath: '/tmp/result.json',
    ...overrides,
  };
}

function setupDb() {
  const db = openDatabase(':memory:');
  applyMigrations(db);
  const runs = new RunRepository(db);
  runs.insertIfNoActive({
    uuid: '00000000-0000-0000-0000-000000000001',
    displayId: 'run-1',
    issueNumber: 1,
    type: 'issue',
    status: 'running',
    completedPhases: [],
    startedAt: new Date(),
  } as never);
  return { db };
}

describe('AgentInvocationRepository', () => {
  it('round-trips an invocation with every field', () => {
    const { db } = setupDb();
    const repo = new AgentInvocationRepository(db);
    const inv = sample();
    repo.insert(inv);
    const got = repo.findById(inv.id);
    expect(got).toEqual(inv);
    expect(got?.startedAt).toBeInstanceOf(Date);
  });
  it('updates outcome + endedAt', () => {
    const { db } = setupDb();
    const repo = new AgentInvocationRepository(db);
    const inv = sample({ outcome: undefined, endedAt: undefined, contractViolations: undefined });
    repo.insert(inv);
    repo.update(inv.id, {
      outcome: 'failed',
      endedAt: new Date('2026-05-22T10:02:00.000Z'),
      exitCode: 1,
      durationMs: 120_000,
      contractViolations: ['boom'],
    });
    const got = repo.findById(inv.id);
    expect(got?.outcome).toBe('failed');
    expect(got?.exitCode).toBe(1);
    expect(got?.contractViolations).toEqual(['boom']);
    expect(got?.endedAt).toEqual(new Date('2026-05-22T10:02:00.000Z'));
  });
  it('lists by run and by run+phase', () => {
    const { db } = setupDb();
    const repo = new AgentInvocationRepository(db);
    repo.insert(sample({ id: AgentInvocationId('a'), phaseId: PhaseName('p1') }));
    repo.insert(sample({ id: AgentInvocationId('b'), phaseId: PhaseName('p1') }));
    repo.insert(sample({ id: AgentInvocationId('c'), phaseId: PhaseName('p2') }));
    const r1 = repo.listByRun(RunId('00000000-0000-0000-0000-000000000001'));
    expect(r1.map((i) => i.id).sort()).toEqual(['a', 'b', 'c']);
    const p1 = repo.listByRunAndPhase(
      RunId('00000000-0000-0000-0000-000000000001'),
      PhaseName('p1'),
    );
    expect(p1.map((i) => i.id).sort()).toEqual(['a', 'b']);
  });
  it('lists by runtime', () => {
    const { db } = setupDb();
    const repo = new AgentInvocationRepository(db);
    repo.insert(sample({ id: AgentInvocationId('a'), runtime: 'opencode' }));
    repo.insert(sample({ id: AgentInvocationId('b'), runtime: 'pi' }));
    expect(repo.listByRuntime('pi').map((i) => i.id)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Run test, expect fail.**

- [ ] **Step 3: Implement** — `packages/infrastructure/src/sqlite/agent-invocation-repository.ts`:

```ts
import type { Db } from './database.js';
import {
  AgentInvocationId,
  AgentProfileName,
  PhaseName,
  RunId,
  type AgentInvocation,
  type AgentInvocationOutcome,
  type AgentRuntimeKind,
} from '@ai-sdlc/domain';
import type { AgentInvocationPort, AgentInvocationUpdatePatch } from '@ai-sdlc/application';

interface Row {
  id: string;
  run_uuid: string;
  phase_id: string;
  step_id: string | null;
  profile: string;
  runtime: string;
  provider: string;
  model: string;
  skill: string | null;
  prompt_path: string;
  prompt_chars: number;
  prompt_tokens_approx: number | null;
  stdout_path: string;
  stderr_path: string;
  started_at: string;
  ended_at: string | null;
  start_commit_sha: string;
  end_commit_sha: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  timeout_ms: number;
  outcome: string | null;
  contract_violations: string;
  result_json_path: string | null;
  fallback_of_invocation_id: string | null;
}

function rowToInvocation(r: Row): AgentInvocation {
  return {
    id: AgentInvocationId(r.id),
    runId: RunId(r.run_uuid),
    phaseId: PhaseName(r.phase_id),
    stepId: r.step_id ?? undefined,
    profile: AgentProfileName(r.profile),
    runtime: r.runtime as AgentRuntimeKind,
    provider: r.provider,
    model: r.model,
    skill: r.skill ?? undefined,
    promptPath: r.prompt_path,
    promptChars: r.prompt_chars,
    promptTokensApprox: r.prompt_tokens_approx ?? undefined,
    stdoutPath: r.stdout_path,
    stderrPath: r.stderr_path,
    startedAt: new Date(r.started_at),
    endedAt: r.ended_at ? new Date(r.ended_at) : undefined,
    startCommitSha: r.start_commit_sha,
    endCommitSha: r.end_commit_sha ?? undefined,
    exitCode: r.exit_code ?? undefined,
    durationMs: r.duration_ms ?? undefined,
    timeoutMs: r.timeout_ms,
    outcome: (r.outcome as AgentInvocationOutcome | null) ?? undefined,
    contractViolations: JSON.parse(r.contract_violations) as string[],
    resultJsonPath: r.result_json_path ?? undefined,
    fallbackOfInvocationId: r.fallback_of_invocation_id
      ? AgentInvocationId(r.fallback_of_invocation_id)
      : undefined,
  };
}

export class AgentInvocationRepository implements AgentInvocationPort {
  constructor(private readonly db: Db) {}

  insert(inv: AgentInvocation): void {
    this.db
      .prepare(
        `INSERT INTO agent_invocations (
          id, run_uuid, phase_id, step_id, profile, runtime, provider, model, skill,
          prompt_path, prompt_chars, prompt_tokens_approx,
          stdout_path, stderr_path,
          started_at, ended_at, start_commit_sha, end_commit_sha,
          exit_code, duration_ms, timeout_ms,
          outcome, contract_violations, result_json_path, fallback_of_invocation_id
        ) VALUES (
          @id, @runId, @phaseId, @stepId, @profile, @runtime, @provider, @model, @skill,
          @promptPath, @promptChars, @promptTokensApprox,
          @stdoutPath, @stderrPath,
          @startedAt, @endedAt, @startCommitSha, @endCommitSha,
          @exitCode, @durationMs, @timeoutMs,
          @outcome, @contractViolations, @resultJsonPath, @fallbackOfInvocationId
        )`,
      )
      .run({
        id: inv.id,
        runId: inv.runId,
        phaseId: inv.phaseId,
        stepId: inv.stepId ?? null,
        profile: inv.profile,
        runtime: inv.runtime,
        provider: inv.provider,
        model: inv.model,
        skill: inv.skill ?? null,
        promptPath: inv.promptPath,
        promptChars: inv.promptChars,
        promptTokensApprox: inv.promptTokensApprox ?? null,
        stdoutPath: inv.stdoutPath,
        stderrPath: inv.stderrPath,
        startedAt: inv.startedAt.toISOString(),
        endedAt: inv.endedAt?.toISOString() ?? null,
        startCommitSha: inv.startCommitSha,
        endCommitSha: inv.endCommitSha ?? null,
        exitCode: inv.exitCode ?? null,
        durationMs: inv.durationMs ?? null,
        timeoutMs: inv.timeoutMs,
        outcome: inv.outcome ?? null,
        contractViolations: JSON.stringify(inv.contractViolations ?? []),
        resultJsonPath: inv.resultJsonPath ?? null,
        fallbackOfInvocationId: inv.fallbackOfInvocationId ?? null,
      });
  }

  update(id: AgentInvocationId, patch: AgentInvocationUpdatePatch): void {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.endedAt !== undefined) {
      setClauses.push('ended_at = @endedAt');
      params.endedAt = patch.endedAt.toISOString();
    }
    if (patch.endCommitSha !== undefined) {
      setClauses.push('end_commit_sha = @endCommitSha');
      params.endCommitSha = patch.endCommitSha;
    }
    if (patch.exitCode !== undefined) {
      setClauses.push('exit_code = @exitCode');
      params.exitCode = patch.exitCode;
    }
    if (patch.durationMs !== undefined) {
      setClauses.push('duration_ms = @durationMs');
      params.durationMs = patch.durationMs;
    }
    if (patch.outcome !== undefined) {
      setClauses.push('outcome = @outcome');
      params.outcome = patch.outcome;
    }
    if (patch.contractViolations !== undefined) {
      setClauses.push('contract_violations = @contractViolations');
      params.contractViolations = JSON.stringify(patch.contractViolations);
    }
    if (patch.resultJsonPath !== undefined) {
      setClauses.push('result_json_path = @resultJsonPath');
      params.resultJsonPath = patch.resultJsonPath;
    }
    if (patch.stdoutPath !== undefined) {
      setClauses.push('stdout_path = @stdoutPath');
      params.stdoutPath = patch.stdoutPath;
    }
    if (patch.stderrPath !== undefined) {
      setClauses.push('stderr_path = @stderrPath');
      params.stderrPath = patch.stderrPath;
    }
    if (setClauses.length === 0) return;
    const result = this.db
      .prepare(`UPDATE agent_invocations SET ${setClauses.join(', ')} WHERE id = @id`)
      .run(params);
    if (result.changes === 0) throw new Error(`AgentInvocation ${id} not found`);
  }

  findById(id: AgentInvocationId): AgentInvocation | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_invocations WHERE id = ?`).get(id) as
      | Row
      | undefined;
    return row ? rowToInvocation(row) : undefined;
  }

  listByRun(runId: RunId): AgentInvocation[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_invocations WHERE run_uuid = ? ORDER BY started_at ASC`)
      .all(runId) as Row[];
    return rows.map(rowToInvocation);
  }

  listByRunAndPhase(runId: RunId, phaseId: PhaseName): AgentInvocation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_invocations WHERE run_uuid = ? AND phase_id = ? ORDER BY started_at ASC`,
      )
      .all(runId, phaseId) as Row[];
    return rows.map(rowToInvocation);
  }

  listByRuntime(runtime: AgentRuntimeKind): AgentInvocation[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_invocations WHERE runtime = ? ORDER BY started_at ASC`)
      .all(runtime) as Row[];
    return rows.map(rowToInvocation);
  }
}
```

- [ ] **Step 4: Export** — append to `packages/infrastructure/src/index.ts`:

```ts
export { AgentInvocationRepository } from './sqlite/agent-invocation-repository.js';
```

- [ ] **Step 5: Run tests, expect pass.**
- [ ] **Step 6: Commit** — `git add packages/infrastructure && git commit -m "M4-01(infrastructure): add AgentInvocationRepository"`.

### Task 7: Wire into composeRoot + port conformance

**Files:**

- Modify: `apps/api/src/compose.ts`
- Modify: `apps/api/src/port-conformance.check.ts`

- [ ] **Step 1:** In `apps/api/src/compose.ts`, import + construct the repository and expose on `Container`:

```ts
import { AgentInvocationRepository } from '@ai-sdlc/infrastructure';
// ...
export interface Container {
  // ... existing fields
  agentInvocationRepository: AgentInvocationRepository;
}

// inside composeRoot, after `const runRepository = new RunRepository(db);`:
const agentInvocationRepository = new AgentInvocationRepository(db);

// in the returned object:
return {
  // ...
  agentInvocationRepository,
};
```

- [ ] **Step 2:** Append to `apps/api/src/port-conformance.check.ts`:

```ts
import type { AgentInvocationPort } from '@ai-sdlc/application';
import type { AgentInvocationRepository } from '@ai-sdlc/infrastructure';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _agentInvocationRepo: AgentInvocationPort = null as unknown as AgentInvocationRepository;
```

- [ ] **Step 3: Typecheck** — `pnpm -r typecheck`.
- [ ] **Step 4: Commit** — `git add apps/api && git commit -m "M4-01(api): register AgentInvocationRepository in composeRoot"`.

### Task 8: API surface for invocations

**Files:**

- Create: `apps/api/src/routes/invocations.ts`
- Modify: `apps/api/src/server.ts` (register route)
- Test: `apps/api/src/__tests__/invocations-api.test.ts`

- [ ] **Step 1: Write failing test** — `apps/api/src/__tests__/invocations-api.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { composeRoot } from '../compose.js';
import { buildServer } from '../server.js';
import {
  AgentInvocationId,
  AgentProfileName,
  PhaseName,
  RunId,
  type AgentInvocation,
} from '@ai-sdlc/domain';

describe('GET /api/runs/:uuid/invocations', () => {
  it('returns invocation rows for a run', async () => {
    const c = composeRoot({
      repoRoot: process.cwd(),
      scriptPath: '/bin/true',
      dbPath: ':memory:',
      runsDir: '/tmp/runs-test-' + Math.random(),
    });
    const runUuid = '00000000-0000-0000-0000-000000000099';
    c.runRepository.insertIfNoActive({
      uuid: runUuid,
      displayId: 'run-99',
      issueNumber: 99,
      type: 'issue',
      status: 'running',
      completedPhases: [],
      startedAt: new Date(),
    } as never);
    const inv: AgentInvocation = {
      id: AgentInvocationId('inv-99'),
      runId: RunId(runUuid),
      phaseId: PhaseName('plan-design'),
      profile: AgentProfileName('opencode-frontier'),
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      promptPath: '/p',
      promptChars: 100,
      stdoutPath: '/s',
      stderrPath: '/e',
      startedAt: new Date('2026-05-22T10:00:00Z'),
      endedAt: new Date('2026-05-22T10:01:00Z'),
      startCommitSha: 'a'.repeat(40),
      timeoutMs: 60000,
      outcome: 'success',
      durationMs: 60000,
      contractViolations: ['x'],
    };
    c.agentInvocationRepository.insert(inv);
    const app = await buildServer(c);
    const res = await app.inject({ url: `/api/runs/${runUuid}/invocations` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { invocations: Array<Record<string, unknown>> };
    expect(body.invocations).toHaveLength(1);
    const got = body.invocations[0];
    expect(got).toMatchObject({
      id: 'inv-99',
      profile: 'opencode-frontier',
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      promptChars: 100,
      durationMs: 60000,
      outcome: 'success',
    });
    expect(got.contractViolationsCount).toBe(1);
    expect(app.close());
  });
});
```

- [ ] **Step 2: Run test, expect fail** (route 404).

- [ ] **Step 3: Implement** — `apps/api/src/routes/invocations.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { RunId } from '@ai-sdlc/domain';
import type { Container } from '../compose.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerInvocationsRoutes(app: FastifyInstance, c: Container): void {
  app.get<{ Params: { uuid: string } }>('/api/runs/:uuid/invocations', async (req, reply) => {
    const { uuid } = req.params;
    if (!UUID_RE.test(uuid)) {
      reply.code(400);
      return { error: 'invalid run uuid' };
    }
    const invocations = c.agentInvocationRepository.listByRun(RunId(uuid)).map((i) => ({
      id: i.id,
      phaseId: i.phaseId,
      stepId: i.stepId ?? null,
      profile: i.profile,
      runtime: i.runtime,
      provider: i.provider,
      model: i.model,
      promptChars: i.promptChars,
      promptTokensApprox: i.promptTokensApprox ?? null,
      startedAt: i.startedAt.toISOString(),
      endedAt: i.endedAt?.toISOString() ?? null,
      durationMs: i.durationMs ?? null,
      exitCode: i.exitCode ?? null,
      outcome: i.outcome ?? null,
      contractViolationsCount: (i.contractViolations ?? []).length,
      fallbackOfInvocationId: i.fallbackOfInvocationId ?? null,
    }));
    return { invocations };
  });
}
```

- [ ] **Step 4: Register route** — in `apps/api/src/server.ts` (inside `buildServer`):

```ts
import { registerInvocationsRoutes } from './routes/invocations.js';
// after the other route registrations:
registerInvocationsRoutes(app, container);
```

- [ ] **Step 5: Run tests, expect pass.**
- [ ] **Step 6: Commit** — `git add apps/api && git commit -m "M4-01(api): expose /api/runs/:uuid/invocations"`.

### Task 9: Final verification

- [ ] **Step 1:** `pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm depcruise`. All pass.
- [ ] **Step 2: Stop.** Orchestrator pushes + opens PR.

---

## Story M4-02 — AgentRuntimeRouter + OpenCodeAgentAdapter

**GitHub issue:** #90. **Depends on:** M4-01, M3-06, M3-08, M3-10.

### File structure

- Create: `packages/application/src/agent/contract-violation-codes.ts` — shared string-union of violation codes. **Introduced here; used by all subsequent stories.**
- Create: `packages/infrastructure/src/agent/agent-runtime-router.ts`.
- Create: `packages/infrastructure/src/agent/opencode-adapter.ts`.
- Create: `packages/infrastructure/src/agent/index.ts` (barrel).
- Modify: `packages/infrastructure/src/index.ts`.
- Modify: `apps/api/src/compose.ts` — swap `FakeAgentPort` for the real router.
- Modify: `apps/api/src/agent-runtime-registry.ts` — refactor or delete (see Task 7).
- Create: `packages/infrastructure/src/agent/__fixtures__/fake-opencode.sh` — shim.
- Tests:
  - `packages/infrastructure/src/agent/__tests__/agent-runtime-router.test.ts`
  - `packages/infrastructure/src/agent/__tests__/opencode-adapter.test.ts`

### Task 1: Shared contract-violation codes

**Files:**

- Create: `packages/application/src/agent/contract-violation-codes.ts`
- Modify: `packages/application/src/index.ts`

- [ ] **Step 1: Create the codes file:**

```ts
export const CONTRACT_VIOLATION_CODES = [
  'prompt_budget_exceeded',
  'missing_required_artifact',
  'invalid_result_json',
  'invalid_result_value',
  'branch_changed',
  'missing_commit',
  'not_pushed',
  'replies_not_posted',
  'cancelled_by_orchestrator',
] as const;

export type ContractViolationCode = (typeof CONTRACT_VIOLATION_CODES)[number];
```

- [ ] **Step 2: Re-export** — append to `packages/application/src/index.ts`:

```ts
export * from './agent/contract-violation-codes.js';
```

- [ ] **Step 3: Typecheck.**
- [ ] **Step 4: Commit** — `git add packages/application && git commit -m "M4-02(application): add shared contract-violation codes"`.

### Task 2: AgentRuntimeRouter scaffolding + invocation row writes

**Files:**

- Create: `packages/infrastructure/src/agent/agent-runtime-router.ts`
- Create: `packages/infrastructure/src/agent/index.ts`
- Modify: `packages/infrastructure/src/index.ts`
- Test: `packages/infrastructure/src/agent/__tests__/agent-runtime-router.test.ts`

- [ ] **Step 1: Write failing test** — covers: pre-insert row before adapter; update row after adapter returns; unknown profile → ConfigError; missing adapter → ConfigError; only-opencode-registered case works:

```ts
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AgentInvocationId, AgentProfileName, type AgentInvocation } from '@ai-sdlc/domain';
import {
  FakeAgentInvocationPort,
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
} from '@ai-sdlc/application';
import { ConfigError, type AgentConfig } from '@ai-sdlc/shared';
import { AgentRuntimeRouter } from '../agent-runtime-router.js';

function cfg(): AgentConfig {
  return {
    defaultProfile: 'opencode-frontier',
    profiles: {
      'opencode-frontier': {
        runtime: 'opencode',
        provider: 'anthropic',
        model: 'm',
        timeoutMinutes: 1,
      },
      'pi-local': {
        runtime: 'pi',
        provider: 'local',
        model: 'q',
        timeoutMinutes: 1,
        contextLimitTokens: 64000,
      },
    },
    phaseProfiles: {
      'plan-design': { profile: 'opencode-frontier' },
    },
  };
}

function req(overrides: Partial<AgentInvocationRequest> = {}): AgentInvocationRequest {
  return {
    profile: AgentProfileName('opencode-frontier'),
    promptPath: '/tmp/prompt.md',
    expectedArtifacts: [],
    cwd: '/tmp',
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r1',
    phaseId: 'plan-design',
    ...overrides,
  };
}

class StubAdapter implements AgentPort {
  constructor(private readonly result: AgentInvocationResult) {}
  async invoke(_: AgentInvocationRequest): Promise<AgentInvocationResult> {
    return this.result;
  }
}

const FIXED_NOW = new Date('2026-05-22T12:00:00.000Z');

describe('AgentRuntimeRouter', () => {
  it('pre-inserts then updates the invocation row on success', async () => {
    const inv = new FakeAgentInvocationPort();
    const adapter = new StubAdapter({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'm',
      exitCode: 0,
      durationMs: 1234,
      stdoutPath: '/tmp/stdout.log',
      stderrPath: '/tmp/stderr.log',
      contractViolations: [],
      outcome: 'success',
    });
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: adapter },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-fixed',
      readPromptChars: () => 100,
    });
    const result = await router.invoke(req({ startCommitSha: 'a'.repeat(40) } as never));
    expect(result.outcome).toBe('success');
    const row = inv.findById(AgentInvocationId('inv-fixed'));
    expect(row).toBeDefined();
    expect(row?.outcome).toBe('success');
    expect(row?.promptChars).toBe(100);
    expect(row?.runtime).toBe('opencode');
  });

  it('throws ConfigError on unknown profile', async () => {
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: { opencode: new StubAdapter({} as never) },
      invocationRepository: new FakeAgentInvocationPort(),
      clock: () => FIXED_NOW,
      idFactory: () => randomUUID(),
      readPromptChars: () => 0,
    });
    await expect(
      router.invoke(req({ profile: AgentProfileName('does-not-exist') })),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when no adapter registered for runtime', async () => {
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: {}, // no opencode adapter
      invocationRepository: new FakeAgentInvocationPort(),
      clock: () => FIXED_NOW,
      idFactory: () => randomUUID(),
      readPromptChars: () => 0,
    });
    await expect(router.invoke(req())).rejects.toBeInstanceOf(ConfigError);
  });

  it('works with only opencode registered (pi is optional)', async () => {
    const inv = new FakeAgentInvocationPort();
    const router = new AgentRuntimeRouter({
      agent: cfg(),
      adapters: {
        opencode: new StubAdapter({
          runtime: 'opencode',
          provider: 'anthropic',
          model: 'm',
          exitCode: 0,
          durationMs: 1,
          stdoutPath: '/s',
          stderrPath: '/e',
          contractViolations: [],
          outcome: 'success',
        }),
      },
      invocationRepository: inv,
      clock: () => FIXED_NOW,
      idFactory: () => 'inv-x',
      readPromptChars: () => 1,
    });
    const r = await router.invoke(req());
    expect(r.outcome).toBe('success');
  });
});
```

- [ ] **Step 2: Run test, expect fail.**

- [ ] **Step 3: Extend `AgentInvocationRequest`** to carry `startCommitSha`. In `packages/application/src/agent/invocation.ts`, add `startCommitSha: string` as required and `expectedArtifacts: string[]` already exists. Update the type:

```ts
export interface AgentInvocationRequest {
  profile: AgentProfileName;
  promptPath: string;
  expectedArtifacts: string[];
  cwd: string;
  runId: string;
  repoId: string;
  workerId?: string;
  phaseId: string;
  stepId?: string;
  startCommitSha: string;
}
```

> Existing test data that constructs an `AgentInvocationRequest` (e.g. M3-06 / M3-07 unit tests) must be updated to pass `startCommitSha`. Run `pnpm -r typecheck` and fix every error; use `'0'.repeat(40)` as the default for tests that don't care about the value.

- [ ] **Step 4: Implement router** — `packages/infrastructure/src/agent/agent-runtime-router.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import {
  AgentInvocationId,
  AgentProfileName,
  PhaseName,
  RunId,
  type AgentInvocation,
  type AgentRuntimeKind,
} from '@ai-sdlc/domain';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
  type AgentInvocationPort,
} from '@ai-sdlc/application';
import { ConfigError, type AgentConfig } from '@ai-sdlc/shared';

export interface AgentRuntimeRouterOptions {
  agent: AgentConfig;
  adapters: Partial<Record<AgentRuntimeKind, AgentPort>>;
  invocationRepository: AgentInvocationPort;
  clock?: () => Date;
  idFactory?: () => string;
  readPromptChars?: (path: string) => number;
}

export class AgentRuntimeRouter implements AgentPort {
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly readPromptChars: (path: string) => number;

  constructor(private readonly opts: AgentRuntimeRouterOptions) {
    this.clock = opts.clock ?? (() => new Date());
    this.idFactory = opts.idFactory ?? (() => randomUUID());
    this.readPromptChars = opts.readPromptChars ?? defaultReadPromptChars;
  }

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const profile = this.opts.agent.profiles[request.profile];
    if (!profile) {
      throw new ConfigError(`unknown profile '${request.profile}'`);
    }
    const adapter = this.opts.adapters[profile.runtime];
    if (!adapter) {
      throw new ConfigError(`no adapter registered for runtime '${profile.runtime}'`);
    }
    const id = AgentInvocationId(this.idFactory());
    const startedAt = this.clock();
    const promptChars = this.readPromptChars(request.promptPath);
    const pre: AgentInvocation = {
      id,
      runId: RunId(request.runId),
      phaseId: PhaseName(request.phaseId),
      stepId: request.stepId,
      profile: request.profile,
      runtime: profile.runtime,
      provider: profile.provider,
      model: profile.model,
      promptPath: request.promptPath,
      promptChars,
      stdoutPath: '',
      stderrPath: '',
      startedAt,
      startCommitSha: request.startCommitSha,
      timeoutMs: profile.timeoutMinutes * 60_000,
      contractViolations: [],
    };
    this.opts.invocationRepository.insert(pre);

    const result = await adapter.invoke(request);

    const endedAt = this.clock();
    this.opts.invocationRepository.update(id, {
      endedAt,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outcome: result.outcome,
      contractViolations: result.contractViolations,
      resultJsonPath: result.resultJsonPath,
      stdoutPath: result.stdoutPath,
      stderrPath: result.stderrPath,
    });
    return result;
  }
}

function defaultReadPromptChars(path: string): number {
  try {
    if (statSync(path).size === 0) return 0;
    return readFileSync(path, 'utf-8').length;
  } catch {
    return 0;
  }
}
```

- [ ] **Step 5: Barrel** — create `packages/infrastructure/src/agent/index.ts`:

```ts
export { AgentRuntimeRouter, type AgentRuntimeRouterOptions } from './agent-runtime-router.js';
```

Add to `packages/infrastructure/src/index.ts`:

```ts
export * from './agent/index.js';
```

- [ ] **Step 6: Run tests, expect pass.**
- [ ] **Step 7: Commit** — `git add packages/infrastructure packages/application && git commit -m "M4-02(infrastructure): add AgentRuntimeRouter (mechanical dispatch + row writes)"`.

### Task 3: OpenCodeAgentAdapter — success path

**Files:**

- Create: `packages/infrastructure/src/agent/opencode-adapter.ts`
- Create: `packages/infrastructure/src/agent/__fixtures__/fake-opencode-success.sh`
- Test: `packages/infrastructure/src/agent/__tests__/opencode-adapter.test.ts`

- [ ] **Step 1: Create the success shim** — `packages/infrastructure/src/agent/__fixtures__/fake-opencode-success.sh`:

```sh
#!/usr/bin/env bash
set -euo pipefail
echo "fake opencode success" >&1
echo "no errors" >&2
exit 0
```

Make executable: `chmod +x packages/infrastructure/src/agent/__fixtures__/fake-opencode-success.sh`.

- [ ] **Step 2: Write failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { AgentProfileName } from '@ai-sdlc/domain';
import { OpenCodeAgentAdapter } from '../opencode-adapter.js';

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@test', { cwd: dir });
  execSync('git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'x');
  execSync('git add . && git commit -q -m init', { cwd: dir });
  return dir;
}

describe('OpenCodeAgentAdapter', () => {
  it('returns success outcome for a 0-exit child', async () => {
    const cwd = makeWorktree();
    const adapter = new OpenCodeAgentAdapter({
      binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-success.sh'),
      artifactsDir: cwd,
    });
    const result = await adapter.invoke({
      profile: AgentProfileName('opencode-frontier'),
      promptPath: '/dev/null',
      expectedArtifacts: [],
      cwd,
      runId: '00000000-0000-0000-0000-000000000001',
      repoId: 'r',
      phaseId: 'plan-design',
      startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    });
    expect(result.outcome).toBe('success');
    expect(result.exitCode).toBe(0);
    expect(readFileSync(result.stdoutPath, 'utf-8')).toContain('fake opencode success');
    expect(readFileSync(result.stderrPath, 'utf-8')).toContain('no errors');
  });
});
```

- [ ] **Step 3: Run test, expect fail.**

- [ ] **Step 4: Implement adapter** — `packages/infrastructure/src/agent/opencode-adapter.ts`:

```ts
import { execa, type ExecaChildProcess } from 'execa';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentPort,
  type AgentInvocationRequest,
  type AgentInvocationResult,
} from '@ai-sdlc/application';
import { execSync } from 'node:child_process';

export interface OpenCodeAdapterOptions {
  binaryPath?: string;
  artifactsDir: string; // base dir; per-invocation subdir created
  timeoutMsDefault?: number;
}

export class OpenCodeAgentAdapter implements AgentPort {
  constructor(private readonly opts: OpenCodeAdapterOptions) {}

  async invoke(request: AgentInvocationRequest): Promise<AgentInvocationResult> {
    const bin = this.opts.binaryPath ?? 'opencode';
    const invocationDir = join(
      this.opts.artifactsDir,
      `inv-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(invocationDir, { recursive: true });
    const stdoutPath = join(invocationDir, 'stdout.log');
    const stderrPath = join(invocationDir, 'stderr.log');

    const start = Date.now();
    let child: ExecaChildProcess | null = null;
    let outcome: AgentInvocationResult['outcome'] = 'success';
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    try {
      child = execa(bin, ['run', '--prompt-file', request.promptPath], {
        cwd: request.cwd,
        reject: false,
        timeout: this.opts.timeoutMsDefault,
        all: false,
      });
      const r = await child;
      stdout = r.stdout ?? '';
      stderr = r.stderr ?? '';
      exitCode = r.exitCode ?? 0;
      if (r.timedOut) outcome = 'timeout';
      else if (exitCode !== 0) outcome = 'failed';
    } catch (e) {
      outcome = 'failed';
      exitCode = 1;
      stderr = String((e as Error).message);
    }
    writeFileSync(stdoutPath, stdout);
    writeFileSync(stderrPath, stderr);

    const durationMs = Date.now() - start;
    let endCommitSha: string | undefined;
    try {
      endCommitSha = execSync('git rev-parse HEAD', { cwd: request.cwd }).toString().trim();
    } catch {
      endCommitSha = undefined;
    }
    void endCommitSha; // not part of AgentInvocationResult shape; router records via separate path if needed
    return {
      runtime: 'opencode',
      provider: '',
      model: '',
      exitCode,
      durationMs,
      stdoutPath,
      stderrPath,
      contractViolations: [],
      outcome,
    };
  }
}
```

> Note: `AgentInvocationResult` from M3-07 does not currently carry `provider`/`model`/`endCommitSha`. The router fills `provider`/`model` from the resolved profile, not the adapter — leaving them empty here is intentional. `endCommitSha` is captured in a follow-up task (Task 5).

- [ ] **Step 5: Barrel export** — append to `packages/infrastructure/src/agent/index.ts`:

```ts
export { OpenCodeAgentAdapter, type OpenCodeAdapterOptions } from './opencode-adapter.js';
```

- [ ] **Step 6: Run tests, expect pass.**
- [ ] **Step 7: Commit** — `git add packages/infrastructure && git commit -m "M4-02(infrastructure): add OpenCodeAgentAdapter (success path)"`.

### Task 4: OpenCodeAgentAdapter — failure / timeout / SIGTERM

**Files:**

- Create: `packages/infrastructure/src/agent/__fixtures__/fake-opencode-fail.sh`
- Create: `packages/infrastructure/src/agent/__fixtures__/fake-opencode-slow.sh`
- Modify: `packages/infrastructure/src/agent/opencode-adapter.ts`
- Modify: `packages/infrastructure/src/agent/__tests__/opencode-adapter.test.ts`

- [ ] **Step 1: Add shims:**

`fake-opencode-fail.sh`:

```sh
#!/usr/bin/env bash
echo "fake fail" >&2
exit 7
```

`fake-opencode-slow.sh`:

```sh
#!/usr/bin/env bash
echo "starting"
sleep 30
echo "done"
```

`chmod +x` both.

- [ ] **Step 2: Append failing tests** — `opencode-adapter.test.ts`:

```ts
it('returns failed outcome for non-zero exit', async () => {
  const cwd = makeWorktree();
  const adapter = new OpenCodeAgentAdapter({
    binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-fail.sh'),
    artifactsDir: cwd,
  });
  const r = await adapter.invoke({
    profile: AgentProfileName('opencode-frontier'),
    promptPath: '/dev/null',
    expectedArtifacts: [],
    cwd,
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r',
    phaseId: 'plan-design',
    startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
  });
  expect(r.outcome).toBe('failed');
  expect(r.exitCode).toBe(7);
});

it('returns timeout outcome when child exceeds timeout', async () => {
  const cwd = makeWorktree();
  const adapter = new OpenCodeAgentAdapter({
    binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-slow.sh'),
    artifactsDir: cwd,
    timeoutMsDefault: 500,
  });
  const r = await adapter.invoke({
    profile: AgentProfileName('opencode-frontier'),
    promptPath: '/dev/null',
    expectedArtifacts: [],
    cwd,
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r',
    phaseId: 'plan-design',
    startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
  });
  expect(r.outcome).toBe('timeout');
});
```

- [ ] **Step 3: Run tests, confirm failure path already passes; the timeout path may already pass if `execa`'s timeout is honoured. If not, adjust the adapter (the current code passes `timeout` and inspects `r.timedOut`).**
- [ ] **Step 4: SIGTERM cleanup.** Add a test that spawns a long-running shim, sends SIGTERM after 100ms, and asserts the adapter's promise resolves quickly:

```ts
it('terminates child on SIGTERM-like cancellation via AbortController', async () => {
  const cwd = makeWorktree();
  const adapter = new OpenCodeAgentAdapter({
    binaryPath: join(__dirname, '..', '__fixtures__', 'fake-opencode-slow.sh'),
    artifactsDir: cwd,
  });
  const controller = new AbortController();
  const p = adapter.invoke({
    profile: AgentProfileName('opencode-frontier'),
    promptPath: '/dev/null',
    expectedArtifacts: [],
    cwd,
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r',
    phaseId: 'plan-design',
    startCommitSha: execSync('git rev-parse HEAD', { cwd }).toString().trim(),
    abortSignal: controller.signal,
  } as never);
  setTimeout(() => controller.abort(), 100);
  const r = await p;
  expect(['failed', 'timeout']).toContain(r.outcome);
});
```

> This test requires `AgentInvocationRequest` to carry an optional `abortSignal`. Add it.

- [ ] **Step 5: Extend `AgentInvocationRequest`** in `packages/application/src/agent/invocation.ts`:

```ts
export interface AgentInvocationRequest {
  // ... existing fields
  abortSignal?: AbortSignal;
}
```

- [ ] **Step 6: Update adapter to honour `abortSignal`:**

In `opencode-adapter.ts`, pass `signal: request.abortSignal` to `execa`, and treat abort as `outcome: 'failed'` with `contractViolations: ['cancelled_by_orchestrator']`. Import the violation code from `@ai-sdlc/application`.

```ts
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application';
// ...
child = execa(bin, ['run', '--prompt-file', request.promptPath], {
  cwd: request.cwd,
  reject: false,
  timeout: this.opts.timeoutMsDefault,
  signal: request.abortSignal,
});
// ...
if (r.isCanceled) {
  outcome = 'failed';
  return {
    // ...
    contractViolations: ['cancelled_by_orchestrator'],
    outcome,
  };
}
```

- [ ] **Step 7: Run all opencode-adapter tests, expect pass.**
- [ ] **Step 8: Commit** — `git add packages/infrastructure packages/application && git commit -m "M4-02(infrastructure): OpenCodeAgentAdapter handles failure, timeout, cancellation"`.

### Task 5: Capture endCommitSha through the router

**Files:**

- Modify: `packages/application/src/agent/invocation.ts`
- Modify: `packages/infrastructure/src/agent/opencode-adapter.ts`
- Modify: `packages/infrastructure/src/agent/agent-runtime-router.ts`
- Test: extend `agent-runtime-router.test.ts`

- [ ] **Step 1:** Add `endCommitSha?: string` to `AgentInvocationResult`.
- [ ] **Step 2:** In the OpenCode adapter, set `endCommitSha` on the returned result from `git rev-parse HEAD` (already captured; just include it in the return).
- [ ] **Step 3:** In the router, when updating the row, also pass `endCommitSha` through:

```ts
this.opts.invocationRepository.update(id, {
  // ... existing fields
  endCommitSha: result.endCommitSha,
});
```

(Add `endCommitSha?: string` to `AgentInvocationUpdatePatch` in `packages/application/src/ports/agent-invocation-port.ts` and to the SQL `update` in `agent-invocation-repository.ts` accordingly.)

- [ ] **Step 4: Test:**

```ts
it('records endCommitSha on the invocation row when adapter returns one', async () => {
  const inv = new FakeAgentInvocationPort();
  const adapter = new StubAdapter({
    runtime: 'opencode',
    provider: 'a',
    model: 'm',
    exitCode: 0,
    durationMs: 1,
    stdoutPath: '/s',
    stderrPath: '/e',
    contractViolations: [],
    outcome: 'success',
    endCommitSha: 'c'.repeat(40),
  });
  const router = new AgentRuntimeRouter({
    agent: cfg(),
    adapters: { opencode: adapter },
    invocationRepository: inv,
    clock: () => FIXED_NOW,
    idFactory: () => 'inv-y',
    readPromptChars: () => 1,
  });
  await router.invoke(req({ startCommitSha: 'a'.repeat(40) } as never));
  expect(inv.findById(AgentInvocationId('inv-y'))?.endCommitSha).toBe('c'.repeat(40));
});
```

- [ ] **Step 5: Run tests, expect pass.**
- [ ] **Step 6: Commit.**

### Task 6: Wire real router into composeRoot

**Files:**

- Modify: `apps/api/src/compose.ts`
- Modify or delete: `apps/api/src/agent-runtime-registry.ts`
- Modify: `apps/api/src/__tests__/compose-agent.test.ts` (if needed)

- [ ] **Step 1:** Read the existing `agent-runtime-registry.ts`. Either:
      (a) keep it as a thin wrapper that constructs the real `AgentRuntimeRouter`, or
      (b) delete it and inline construction in `compose.ts`.

  Pick (b) — `composeRoot` is already the composition root. Document the deletion in the commit message.

- [ ] **Step 2: In `compose.ts`,** after loading config, build the router:

```ts
const agentRuntime = config.agent
  ? new AgentRuntimeRouter({
      agent: config.agent,
      adapters: {
        opencode: new OpenCodeAgentAdapter({
          artifactsDir: join(runsDir, 'agent-artifacts'),
        }),
      },
      invocationRepository: agentInvocationRepository,
    })
  : undefined;

return {
  // ...
  agentRuntime,
};
```

- [ ] **Step 3: Update `Container` type and existing test in `compose-agent.test.ts`** so `container.agentRuntime` is either the new router or `undefined`. (The old `AgentRuntimeRegistry` class is gone — adjust assertions.)

- [ ] **Step 4: Run tests; expect pass.**
- [ ] **Step 5: Commit** — `git add apps/api && git commit -m "M4-02(api): wire AgentRuntimeRouter into composeRoot, drop temporary registry"`.

### Task 7: Final verification

- [ ] **Step 1:** `pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm depcruise`. All pass.
- [ ] **Step 2: Stop.**

---

## Story M4-02b — PiAgentAdapter for local Qwen profiles

**GitHub issue:** #91. **Depends on:** M4-01, M4-02.

### File structure

- Create: `packages/infrastructure/src/agent/pi-adapter.ts`.
- Create: `packages/infrastructure/src/agent/__fixtures__/fake-pi-success.sh`, `fake-pi-fail.sh`, `fake-pi-slow.sh`.
- Modify: `packages/infrastructure/src/agent/index.ts`.
- Modify: `apps/api/src/compose.ts` — register `pi` adapter conditionally.
- Test: `packages/infrastructure/src/agent/__tests__/pi-adapter.test.ts`.

### Task 1: PiAgentAdapter success / failure / timeout

**Files:** as above.

- [ ] **Step 1: Create the three Pi shims** (analogues of the OpenCode ones; each prints to stdout, with appropriate exit/sleep). Make them executable.

- [ ] **Step 2: Write failing test** for the success path (mirror OpenCode test). Then add failure and timeout cases.

- [ ] **Step 3: Implement** — `packages/infrastructure/src/agent/pi-adapter.ts`. Structure identical to OpenCode adapter but:
  - Binary defaults to `'pi'`.
  - Argv builder includes `--context-limit` and `--max-output` flags read from `request.profile` resolved via the router. Since the adapter does not receive the profile object directly, the router can pass `profile.contextLimitTokens` and `profile.outputBudgetTokens` via new optional fields on the request, OR the adapter can re-resolve from config. **Choose the former** — extend `AgentInvocationRequest` with an optional `runtimeHints?: { contextLimitTokens?: number; outputBudgetTokens?: number }`. Update the router to populate it from the resolved profile.

- [ ] **Step 4: Run tests, expect pass.**
- [ ] **Step 5: Commit** — `M4-02b(infrastructure): add PiAgentAdapter with budgets and timeouts`.

### Task 2: Prompt budget enforcement

**Files:** modify `pi-adapter.ts`, extend test.

- [ ] **Step 1: Write failing test** — passes a prompt file whose char count divided by 4 exceeds the configured budget. Assert: outcome `'contract_violation'`, `contractViolations: ['prompt_budget_exceeded']`, **no child process spawned** (assert the shim's sentinel file does not exist):

```ts
it('refuses to spawn when prompt exceeds promptBudgetTokens', async () => {
  const cwd = makeWorktree();
  const promptPath = join(cwd, 'big-prompt.md');
  writeFileSync(promptPath, 'x'.repeat(40_000)); // 10_000 tokens approx
  const sentinel = join(cwd, 'shim-ran');
  const shim = join(cwd, 'shim.sh');
  writeFileSync(shim, `#!/usr/bin/env bash\ntouch "${sentinel}"\nexit 0\n`);
  execSync(`chmod +x ${shim}`);
  const adapter = new PiAgentAdapter({ binaryPath: shim, artifactsDir: cwd });
  const r = await adapter.invoke({
    profile: AgentProfileName('pi-local'),
    promptPath,
    expectedArtifacts: [],
    cwd,
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r',
    phaseId: 'plan-design',
    startCommitSha: 'a'.repeat(40),
    runtimeHints: { contextLimitTokens: 1000, outputBudgetTokens: 100 },
    promptBudgetTokens: 1000,
  } as never);
  expect(r.outcome).toBe('contract_violation');
  expect(r.contractViolations).toContain('prompt_budget_exceeded');
  expect(existsSync(sentinel)).toBe(false);
});
```

- [ ] **Step 2: Extend `AgentInvocationRequest`** with optional `promptBudgetTokens?: number` and `runtimeHints?` (if not already added in Task 1).

- [ ] **Step 3: Implement enforcement** in `PiAgentAdapter.invoke`, before spawning:

```ts
import { statSync } from 'node:fs';
import { CONTRACT_VIOLATION_CODES } from '@ai-sdlc/application';

const promptChars = statSync(request.promptPath).size;
const approxTokens = Math.ceil(promptChars / 4); // heuristic: 1 token ≈ 4 chars
if (request.promptBudgetTokens !== undefined && approxTokens > request.promptBudgetTokens) {
  return {
    runtime: 'pi',
    provider: '',
    model: '',
    exitCode: 0,
    durationMs: 0,
    stdoutPath: '',
    stderrPath: '',
    contractViolations: ['prompt_budget_exceeded'],
    outcome: 'contract_violation',
  };
}
```

- [ ] **Step 4: Update router** to populate `promptBudgetTokens` on the outgoing request from the resolved profile.
- [ ] **Step 5: Run tests, expect pass.**
- [ ] **Step 6: Commit** — `M4-02b(infrastructure): enforce promptBudgetTokens before spawning Pi child`.

### Task 3: SIGTERM cleanup (mirror M4-02 task 4 step 4–7)

- [ ] **Step 1: Write the abort test** for Pi (same structure as the OpenCode one).
- [ ] **Step 2: Verify it passes** (the implementation already inherits the `signal` pattern from OpenCode if you copied the structure).
- [ ] **Step 3: Commit.**

### Task 4: Register Pi adapter in composeRoot when config requires it

**Files:** `apps/api/src/compose.ts`.

- [ ] **Step 1:** In `compose.ts`, detect whether any profile uses `runtime: 'pi'`:

```ts
const needsPi = config.agent
  ? Object.values(config.agent.profiles).some((p) => p.runtime === 'pi')
  : false;
const adapters: Partial<Record<AgentRuntimeKind, AgentPort>> = {
  opencode: new OpenCodeAgentAdapter({ artifactsDir: join(runsDir, 'agent-artifacts') }),
};
if (needsPi) {
  adapters.pi = new PiAgentAdapter({ artifactsDir: join(runsDir, 'agent-artifacts') });
}
```

- [ ] **Step 2: Add a test** that loads a config with a Pi profile and asserts `container.agentRuntime` accepts a Pi-profile invocation without throwing `ConfigError("no adapter registered for runtime 'pi'")`. Use a fake binary path or override the adapter for the test.

- [ ] **Step 3: Run tests, expect pass.**
- [ ] **Step 4: Commit.**

### Task 5: Final verification

- [ ] `pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm depcruise`. All pass.
- [ ] Stop.

---

## Story M4-02c — Agent profile routing and fallback config

**GitHub issue:** #92. **Depends on:** M4-02, M4-02b.

### File structure

- Modify: `packages/application/src/agent/invocation.ts` — add `fallbackOfInvocationId?` and `fallbackReason?` to `AgentInvocationRequest`.
- Modify: `packages/application/src/ports/agent-invocation-port.ts` — patch already supports the field (re-confirm).
- Modify: `packages/infrastructure/src/agent/agent-runtime-router.ts` — fallback dispatch.
- Modify: `packages/shared/src/events/schema.ts` if needed (no — event type is freeform string; we just emit `phase.fallback.escalated`).
- Tests:
  - `packages/infrastructure/src/agent/__tests__/router-fallback.test.ts` — adapter-level triggers.
  - `packages/infrastructure/src/agent/__tests__/router-fallback-caller-signal.test.ts` — caller-signalled.
  - `packages/infrastructure/src/agent/__tests__/router-fallback-none.test.ts` — no fallback configured.

### Task 1: Extend request with fallback fields

**Files:**

- Modify: `packages/application/src/agent/invocation.ts`

- [ ] **Step 1: Add fields:**

```ts
export interface AgentInvocationRequest {
  // ... existing
  fallbackOfInvocationId?: AgentInvocationId;
  fallbackReason?: string; // capped to 64 chars by router (defence in depth)
}
```

Import `AgentInvocationId` from `@ai-sdlc/domain`.

- [ ] **Step 2: Typecheck.**
- [ ] **Step 3: Commit** — `M4-02c(application): extend AgentInvocationRequest with fallback signalling fields`.

### Task 2: Router-side fallback — adapter-level triggers

**Files:**

- Modify: `packages/infrastructure/src/agent/agent-runtime-router.ts`
- Test: `packages/infrastructure/src/agent/__tests__/router-fallback.test.ts`

- [ ] **Step 1: Write failing test** for each trigger. Skeleton (timeout case shown; replicate for the other four):

```ts
import { describe, it, expect, vi } from 'vitest';
import { AgentInvocationId, AgentProfileName } from '@ai-sdlc/domain';
import {
  FakeAgentInvocationPort,
  type AgentPort,
  type AgentInvocationResult,
} from '@ai-sdlc/application';
import { AgentRuntimeRouter } from '../agent-runtime-router.js';

const cfgWithFallback = () => ({
  defaultProfile: 'pi-local',
  profiles: {
    'pi-local': {
      runtime: 'pi' as const,
      provider: 'local',
      model: 'q',
      timeoutMinutes: 1,
      contextLimitTokens: 64000,
    },
    'opencode-frontier': {
      runtime: 'opencode' as const,
      provider: 'anthropic',
      model: 'm',
      timeoutMinutes: 1,
    },
  },
  phaseProfiles: { 'plan-design': { profile: 'pi-local', fallbackProfile: 'opencode-frontier' } },
});

it('escalates on timeout outcome to fallbackProfile', async () => {
  const inv = new FakeAgentInvocationPort();
  const piAdapter: AgentPort = {
    invoke: async () => ({
      runtime: 'pi',
      provider: 'local',
      model: 'q',
      exitCode: 0,
      durationMs: 1,
      stdoutPath: '',
      stderrPath: '',
      contractViolations: [],
      outcome: 'timeout',
    }),
  };
  const opencodeAdapter: AgentPort = {
    invoke: async () => ({
      runtime: 'opencode',
      provider: 'anthropic',
      model: 'm',
      exitCode: 0,
      durationMs: 2,
      stdoutPath: '',
      stderrPath: '',
      contractViolations: [],
      outcome: 'success',
    }),
  };
  const events: Array<{ type: string; metadata: unknown }> = [];
  const router = new AgentRuntimeRouter({
    agent: cfgWithFallback(),
    adapters: { pi: piAdapter, opencode: opencodeAdapter },
    invocationRepository: inv,
    eventEmitter: {
      publish: (_runId, ev) => {
        events.push({ type: ev.type, metadata: ev.metadata });
      },
    },
    idFactory: (() => {
      let n = 0;
      return () => `inv-${++n}`;
    })(),
    clock: () => new Date('2026-05-22T12:00:00Z'),
    readPromptChars: () => 1,
  });
  const result = await router.invoke({
    profile: AgentProfileName('pi-local'),
    promptPath: '/dev/null',
    expectedArtifacts: [],
    cwd: '/tmp',
    runId: '00000000-0000-0000-0000-000000000001',
    repoId: 'r',
    phaseId: 'plan-design',
    startCommitSha: 'a'.repeat(40),
  });
  expect(result.outcome).toBe('success');
  expect(inv.listByRun(/* runId */ '00000000-0000-0000-0000-000000000001' as any)).toHaveLength(2);
  const escalation = events.find((e) => e.type === 'phase.fallback.escalated');
  expect(escalation).toBeDefined();
  expect(escalation?.metadata).toMatchObject({
    fromProfile: 'pi-local',
    toProfile: 'opencode-frontier',
    triggerOwner: 'router',
  });
});
```

> Repeat with the test factory for each adapter-level trigger: `timeout`, `contract_violation` with `prompt_budget_exceeded`, with `missing_required_artifact`, with `invalid_result_json`, and a generic `contract_violation` with an unrecognised code.

- [ ] **Step 2: Implement.** Modify `agent-runtime-router.ts`:

```ts
import type { EventBusPort } from '@ai-sdlc/application';

export interface AgentRuntimeRouterOptions {
  // ... existing
  eventEmitter?: EventBusPort;
}

// inside invoke(), after first adapter call:
const fallbackProfileName = this.opts.agent.phaseProfiles[request.phaseId]?.fallbackProfile;
const callerSignalled = request.fallbackOfInvocationId !== undefined;
const isAdapterTrigger =
  !callerSignalled &&
  fallbackProfileName !== undefined &&
  (result.outcome === 'timeout' || result.outcome === 'contract_violation');

if (isAdapterTrigger) {
  const triggerReason =
    result.outcome === 'timeout'
      ? 'timeout'
      : (result.contractViolations[0] ?? 'contract_violation');
  this.opts.eventEmitter?.publish(request.runId, {
    runId: request.runId,
    phase: request.phaseId,
    level: 'warn',
    type: 'phase.fallback.escalated',
    message: `escalating ${request.profile} -> ${fallbackProfileName}: ${triggerReason}`,
    timestamp: this.clock().toISOString(),
    metadata: {
      fromProfile: request.profile,
      toProfile: fallbackProfileName,
      triggerReason,
      triggerOwner: 'router',
    },
  });
  const fallback = await this.invoke({
    ...request,
    profile: AgentProfileName(fallbackProfileName),
    fallbackOfInvocationId: id,
    fallbackReason: triggerReason,
  });
  return fallback;
}

// caller-signalled emission:
if (callerSignalled) {
  // Handled at the top of invoke() instead — see below.
}
```

Refactor: emit the caller-signalled event **before** dispatch when `request.fallbackOfInvocationId` is set, with `triggerOwner: 'use_case'` and `triggerReason = request.fallbackReason?.slice(0, 64) ?? 'use_case'`. Set the new invocation row's `fallbackOfInvocationId` from `request.fallbackOfInvocationId`.

```ts
// at top of invoke(), right after id generation:
if (request.fallbackOfInvocationId) {
  pre.fallbackOfInvocationId = request.fallbackOfInvocationId;
  this.opts.eventEmitter?.publish(request.runId, {
    runId: request.runId,
    phase: request.phaseId,
    level: 'warn',
    type: 'phase.fallback.escalated',
    message: `use-case-signalled fallback to ${request.profile}`,
    timestamp: startedAt.toISOString(),
    metadata: {
      toProfile: request.profile,
      triggerOwner: 'use_case',
      triggerReason: (request.fallbackReason ?? 'use_case').slice(0, 64),
    },
  });
}
```

- [ ] **Step 3: Run tests, expect pass.**
- [ ] **Step 4: Commit** — `M4-02c(infrastructure): router escalates on adapter-level triggers`.

### Task 3: Caller-signalled fallback

**Files:**

- Test: `router-fallback-caller-signal.test.ts`

- [ ] **Step 1: Write test.** Pass a request with `fallbackOfInvocationId` set; assert: (a) only one invocation occurs (the caller already ran the first one), (b) the row has `fallbackOfInvocationId` set, (c) the event has `triggerOwner: 'use_case'` and the caller's `triggerReason`.

- [ ] **Step 2: Run test.** If the implementation from Task 2 is right, it should already pass — that branch records the row + emits the event.
- [ ] **Step 3: Commit.**

### Task 4: No fallback configured — no escalation

**Files:**

- Test: `router-fallback-none.test.ts`

- [ ] **Step 1: Write test.** Phase `'plan-design'` is configured **without** `fallbackProfile`. Stub adapter returns `outcome: 'timeout'`. Assert exactly one invocation row, no `phase.fallback.escalated` event.

- [ ] **Step 2: Run test.** Implementation already handles this (the `isAdapterTrigger` guard requires `fallbackProfileName !== undefined`).
- [ ] **Step 3: Commit.**

### Task 5: Bounded chain — fallback failure does not escalate further

**Files:**

- Test: append to `router-fallback.test.ts`

- [ ] **Step 1: Write test.** Configure `pi-local` with `fallbackProfile: 'opencode-frontier'`. Both adapters return `outcome: 'failed'`. Assert: exactly two invocation rows total, no third invocation.

- [ ] **Step 2: Verify implementation.** The recursive `invoke` call carries `fallbackOfInvocationId` — but the router uses this signal to suppress its own escalation. Add explicit guard:

```ts
const isAdapterTrigger =
  !callerSignalled &&
  request.fallbackOfInvocationId === undefined && // do not chain
  fallbackProfileName !== undefined &&
  (result.outcome === 'timeout' || result.outcome === 'contract_violation');
```

Wait — when the router recurses, it passes `fallbackOfInvocationId: id`. The recursive call sees `request.fallbackOfInvocationId !== undefined`, treats it as caller-signalled, and emits the use-case event. That is wrong — the recursion is router-internal, not use-case-signalled. Fix: add an internal flag, e.g. introduce a private `dispatch(request, fallbackOfInvocationId?, callerSignalled?)` helper, and have `invoke` (the public method) call it with `callerSignalled = request.fallbackOfInvocationId !== undefined`. The recursive case calls `dispatch(..., id, false)`.

- [ ] **Step 3: Refactor router** to split public `invoke` from private `dispatch`. Re-run all router tests.
- [ ] **Step 4: Commit.**

### Task 6: Pass EventBusPort through composeRoot

**Files:**

- Modify: `apps/api/src/compose.ts`

- [ ] **Step 1:** In `composeRoot`, pass the existing `InMemoryEventBus` (already created) into the router options as `eventEmitter`.

- [ ] **Step 2: Run all api tests, expect pass.**
- [ ] **Step 3: Commit** — `M4-02c(api): wire EventBus into AgentRuntimeRouter`.

### Task 7: Final verification

- [ ] `pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm depcruise`. All pass.
- [ ] Stop.

---

## Story M4-03 — Prompt templating + context injection

**GitHub issue:** #93. **Depends on:** M4-02.

### File structure

- Create: `packages/application/src/prompts/render-prompt.ts`
- Create: `packages/application/src/prompts/load-prompt-template.ts`
- Create: `packages/application/src/prompts/errors.ts`
- Create: `packages/application/src/prompts/index.ts` (barrel)
- Modify: `packages/application/src/index.ts`
- Create: `prompts/.gitkeep`
- Test: `packages/application/src/__tests__/render-prompt.test.ts`

### Task 1: Error classes + render function — happy path

**Files:** above.

- [ ] **Step 1: Write failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { renderPrompt } from '../prompts/render-prompt.js';
import type { ArtifactStore } from '../ports/artifact-store.js';

const fakeArtifacts = (map: Record<string, string>): ArtifactStore => ({
  async read(path) {
    if (!(path in map)) throw new Error('not found');
    return map[path];
  },
  async write() {
    throw new Error('not in scope');
  },
  async list() {
    return [];
  },
});

describe('renderPrompt', () => {
  it('substitutes vars', async () => {
    const out = await renderPrompt('hello {{var:name}}, the answer is {{var:n}}', {
      vars: { name: 'world', n: '42' },
      artifacts: fakeArtifacts({}),
    });
    expect(out).toBe('hello world, the answer is 42');
  });
  it('substitutes artifacts by path', async () => {
    const out = await renderPrompt('plan:\n{{artifact:plan.md}}', {
      vars: {},
      artifacts: fakeArtifacts({ 'plan.md': 'PLAN BODY' }),
    });
    expect(out).toBe('plan:\nPLAN BODY');
  });
  it('throws TemplateError on unknown var', async () => {
    await expect(
      renderPrompt('{{var:missing}}', { vars: {}, artifacts: fakeArtifacts({}) }),
    ).rejects.toThrow(/missing/);
  });
  it('throws TemplateError on missing artifact', async () => {
    await expect(
      renderPrompt('{{artifact:nope.md}}', { vars: {}, artifacts: fakeArtifacts({}) }),
    ).rejects.toThrow(/nope.md/);
  });
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement:**

`packages/application/src/prompts/errors.ts`:

```ts
export class TemplateError extends Error {
  constructor(
    message: string,
    public readonly placeholder: string,
  ) {
    super(message);
    this.name = 'TemplateError';
  }
}
export class TemplateNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateNotFoundError';
  }
}
```

`packages/application/src/prompts/render-prompt.ts`:

```ts
import { TemplateError } from './errors.js';
import type { ArtifactStore } from '../ports/artifact-store.js';

export interface PromptContext {
  vars: Record<string, string>;
  artifacts: ArtifactStore;
}

const PLACEHOLDER_RE = /\{\{(var|artifact):([^}]+)\}\}/g;

export async function renderPrompt(template: string, ctx: PromptContext): Promise<string> {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    const [full, kind, key] = m;
    const start = m.index!;
    const end = start + full.length;
    let value: string;
    if (kind === 'var') {
      const v = ctx.vars[key.trim()];
      if (v === undefined) throw new TemplateError(`unknown var: ${key}`, key);
      value = v;
    } else {
      try {
        value = await ctx.artifacts.read(key.trim());
      } catch {
        throw new TemplateError(`missing artifact: ${key}`, key);
      }
    }
    replacements.push({ start, end, value });
  }
  let result = '';
  let cursor = 0;
  for (const r of replacements) {
    result += template.slice(cursor, r.start) + r.value;
    cursor = r.end;
  }
  result += template.slice(cursor);
  return result;
}
```

- [ ] **Step 4: Run tests, expect pass.**
- [ ] **Step 5: Commit** — `M4-03(application): add renderPrompt`.

### Task 2: loadPromptTemplate

**Files:** `load-prompt-template.ts`, barrel, test.

- [ ] **Step 1: Write failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPromptTemplate, TemplateNotFoundError } from '../prompts/index.js';

describe('loadPromptTemplate', () => {
  it('reads prompts/<phase>/<step>.md', () => {
    const root = mkdtempSync(join(tmpdir(), 'prompts-'));
    mkdirSync(join(root, 'prompts', 'plan-design'), { recursive: true });
    writeFileSync(join(root, 'prompts', 'plan-design', 'plan-design.md'), 'TEMPLATE');
    expect(
      loadPromptTemplate('plan-design', 'plan-design', { promptsRoot: join(root, 'prompts') }),
    ).toBe('TEMPLATE');
  });
  it('throws TemplateNotFoundError if missing', () => {
    expect(() => loadPromptTemplate('x', 'y', { promptsRoot: '/nonexistent' })).toThrow(
      TemplateNotFoundError,
    );
  });
});
```

- [ ] **Step 2: Implement:**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TemplateNotFoundError } from './errors.js';

export interface LoadPromptTemplateOpts {
  promptsRoot: string;
}

export function loadPromptTemplate(
  phase: string,
  step: string,
  opts: LoadPromptTemplateOpts,
): string {
  const path = join(opts.promptsRoot, phase, `${step}.md`);
  try {
    return readFileSync(path, 'utf-8');
  } catch (e) {
    throw new TemplateNotFoundError(`prompt template not found: ${path}`);
  }
}
```

`packages/application/src/prompts/index.ts`:

```ts
export * from './errors.js';
export * from './render-prompt.js';
export * from './load-prompt-template.js';
```

Append `export * from './prompts/index.js';` to `packages/application/src/index.ts`.

Create empty `prompts/.gitkeep`.

- [ ] **Step 3: Run tests, expect pass.**
- [ ] **Step 4: Commit** — `M4-03(application): add loadPromptTemplate; create prompts/`.

### Task 3: Final verification

- [ ] `pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm depcruise`. All pass.

> Depcruise may flag `node:fs` import from `loadPromptTemplate.ts`. If so, add an explicit allowlist comment in `.dependency-cruiser.cjs` permitting `fs/path` imports for this file with a justification comment. Run depcruise again and verify clean.

- [ ] Stop.

---

## Story M4-04 — Agent contract validation

**GitHub issue:** #94. **Depends on:** M4-02 (uses violation codes), M3-01.

### File structure

- Create: `packages/domain/src/agent-contract.ts`
- Modify: `packages/domain/src/index.ts`
- Create: `packages/application/src/agent/validate-agent-contract.ts`
- Modify: `packages/application/src/index.ts`
- Test: `packages/application/src/__tests__/validate-agent-contract.test.ts`

### Task 1: AgentContract type

**Files:**

- Create: `packages/domain/src/agent-contract.ts`
- Modify: `packages/domain/src/index.ts`

- [ ] **Step 1: Create the type:**

```ts
export interface AgentContract {
  requiredArtifacts?: string[];
  allowedResultValues?: string[];
  mustNotChangeBranch?: boolean;
  mustCreateCommit?: boolean;
  mustPush?: { remote: string; ref: string };
  mustPostReplies?: { prNumber: number };
}
```

Export from `packages/domain/src/index.ts`.

- [ ] **Step 2: Typecheck.**
- [ ] **Step 3: Commit** — `M4-04(domain): add AgentContract type`.

### Task 2: validateAgentContract — happy path skeleton

**Files:**

- Create: `packages/application/src/agent/validate-agent-contract.ts`
- Test: `packages/application/src/__tests__/validate-agent-contract.test.ts`

- [ ] **Step 1: Write failing test (one invariant at a time)** — start with `requiredArtifacts`:

```ts
import { describe, it, expect } from 'vitest';
import { AgentInvocationId, AgentProfileName, PhaseName, RunId } from '@ai-sdlc/domain';
import type { AgentInvocation } from '@ai-sdlc/domain';
import { FakeArtifactStore, FakeGitPort, FakeGitHubPort } from '../test-doubles/index.js';
import { validateAgentContract } from '../agent/validate-agent-contract.js';

function sampleInv(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    id: AgentInvocationId('inv-1'),
    runId: RunId('r1'),
    phaseId: PhaseName('plan-design'),
    profile: AgentProfileName('p'),
    runtime: 'opencode',
    provider: 'a',
    model: 'm',
    promptPath: '/p',
    promptChars: 1,
    stdoutPath: '/s',
    stderrPath: '/e',
    startedAt: new Date(),
    startCommitSha: 'a'.repeat(40),
    timeoutMs: 1000,
    ...overrides,
  };
}

describe('validateAgentContract — requiredArtifacts', () => {
  it('returns empty when all required artifacts exist', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write(
      { runId: 'r1', phase: 'plan-design', type: 'plan', path: 'plan.md' },
      'body',
    );
    const v = await validateAgentContract({
      contract: { requiredArtifacts: ['plan.md'] },
      invocation: sampleInv(),
      ports: { artifacts, git: new FakeGitPort(), github: new FakeGitHubPort() },
      cwd: '/tmp',
    });
    expect(v).toEqual([]);
  });
  it('returns missing_required_artifact when an artifact is absent', async () => {
    const v = await validateAgentContract({
      contract: { requiredArtifacts: ['plan.md'] },
      invocation: sampleInv(),
      ports: {
        artifacts: new FakeArtifactStore(),
        git: new FakeGitPort(),
        github: new FakeGitHubPort(),
      },
      cwd: '/tmp',
    });
    expect(v).toContain('missing_required_artifact');
  });
});
```

- [ ] **Step 2: Run, expect fail.**

- [ ] **Step 3: Implement skeleton + first invariant:**

```ts
import type { AgentContract, AgentInvocation } from '@ai-sdlc/domain';
import type { ArtifactStore, GitPort, GitHubPort } from '../ports.js';
import type { ContractViolationCode } from './contract-violation-codes.js';

export interface ValidateAgentContractInput {
  contract: AgentContract;
  invocation: AgentInvocation;
  ports: { artifacts: ArtifactStore; git: GitPort; github: GitHubPort };
  cwd: string;
}

export async function validateAgentContract(
  input: ValidateAgentContractInput,
): Promise<ContractViolationCode[]> {
  const violations: ContractViolationCode[] = [];
  const { contract, ports } = input;
  if (contract.requiredArtifacts) {
    for (const path of contract.requiredArtifacts) {
      const exists = await artifactExists(ports.artifacts, path);
      if (!exists) {
        violations.push('missing_required_artifact');
        break; // single code per kind
      }
    }
  }
  return violations;
}

async function artifactExists(store: ArtifactStore, path: string): Promise<boolean> {
  try {
    await store.read(path);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests, expect pass.**
- [ ] **Step 5: Commit** — `M4-04(application): validate requiredArtifacts`.

### Task 3: allowedResultValues

- [ ] **Step 1: Append failing tests** (one valid result, one invalid). Use `invocation.resultJsonPath` and read via `artifacts.read`. The validator parses JSON, reads top-level `result` field, checks against `allowedResultValues`.
- [ ] **Step 2: Implement.** Add a clause to `validateAgentContract`:
  ```ts
  if (contract.allowedResultValues && input.invocation.resultJsonPath) {
    try {
      const raw = await ports.artifacts.read(input.invocation.resultJsonPath);
      const parsed = JSON.parse(raw) as { result?: string };
      if (!parsed.result || !contract.allowedResultValues.includes(parsed.result)) {
        violations.push('invalid_result_value');
      }
    } catch {
      violations.push('invalid_result_value');
    }
  }
  ```
- [ ] **Step 3: Run, expect pass.**
- [ ] **Step 4: Commit.**

### Task 4: mustNotChangeBranch

- [ ] **Step 1: Add `GitPort.currentBranch(cwd)` and `headSha(cwd)` if not present.** Check `packages/application/src/ports/git-port.ts`. If missing, extend and update `FakeGitPort` to mirror.
- [ ] **Step 2: Failing tests:** branch unchanged → no violation. Branch changed → `'branch_changed'`. Commit SHA differs from `startCommitSha` while branch name matches → also `'branch_changed'`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, commit.**

### Task 5: mustCreateCommit

- [ ] **Step 1: Failing tests:** when `endCommitSha === startCommitSha` and `mustCreateCommit: true`, returns `'missing_commit'`. Otherwise empty.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run, commit.**

### Task 6: mustPush + mustPostReplies

- [ ] **Step 1: Add port methods** if missing:
  - `GitPort.remoteRef({ cwd, remote, ref })` returning `string | undefined`.
  - `GitHubPort.listPrComments(prNumber, sinceIso)` returning the comments.
- [ ] **Step 2: Failing tests** for each direction.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, commit.**

### Task 7: Combined acceptance test

- [ ] **Step 1: Write the all-six-pass and all-six-fail tests** that exercise every invariant in one call.
- [ ] **Step 2: Run, expect pass.**
- [ ] **Step 3: Commit.**

### Task 8: Final verification

- [ ] `pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm depcruise`. All pass.
- [ ] Stop.

---

## Story M4-05 — Deterministic result extraction + `result.json` schema

**GitHub issue:** #95. **Depends on:** M4-04, M4-02c. **Closes #51.**

### File structure

- Create: `packages/application/src/results/schemas/<phase>.ts` (7 files).
- Create: `packages/application/src/results/phase-registry.ts`.
- Create: `packages/application/src/results/extract-result.ts`.
- Create: `packages/application/src/results/index.ts` (barrel).
- Modify: `packages/application/src/index.ts`.
- Create: `apps/cli/src/diagnose-result.ts` (diagnostic only).
- Tests:
  - `packages/application/src/__tests__/extract-result.test.ts` (four branches × 7 phases — start with one phase, replicate via parameterised tests).
  - `packages/application/src/__tests__/no-llm-in-extract.test.ts`.
- Test fixtures: `packages/application/src/__tests__/__fixtures__/result-json/<phase>/valid.json` (one per phase).

### Task 1: One phase schema + registry

**Files:**

- Create: `packages/application/src/results/schemas/plan-design.ts`
- Create: `packages/application/src/results/phase-registry.ts`
- Create: `packages/application/src/results/index.ts`
- Modify: `packages/application/src/index.ts`

- [ ] **Step 1: Implement first schema:**

```ts
import { z } from 'zod';
export const planDesignResultSchema = z.object({
  result: z.enum(['ready', 'blocked']),
  summary: z.string().min(1),
});
export type PlanDesignResult = z.infer<typeof planDesignResultSchema>;
```

- [ ] **Step 2: Implement registry:**

```ts
import type { ZodTypeAny } from 'zod';
import { planDesignResultSchema } from './schemas/plan-design.js';

export interface PhaseResultMeta {
  schema: ZodTypeAny;
  retrySafe: boolean;
}

export const PHASE_RESULT_REGISTRY: Record<string, PhaseResultMeta> = {
  'plan-design': { schema: planDesignResultSchema, retrySafe: true },
};
```

- [ ] **Step 3: Barrel + index export.**
- [ ] **Step 4: Typecheck.**
- [ ] **Step 5: Commit** — `M4-05(application): introduce result registry with plan-design schema`.

### Task 2: extractResult — valid path

**Files:**

- Create: `packages/application/src/results/extract-result.ts`
- Test: `packages/application/src/__tests__/extract-result.test.ts`

- [ ] **Step 1: Failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { AgentInvocationId, AgentProfileName, PhaseName, RunId } from '@ai-sdlc/domain';
import type { AgentInvocation } from '@ai-sdlc/domain';
import { FakeArtifactStore, FakeAgentPort } from '../test-doubles/index.js';
import { extractResult } from '../results/extract-result.js';

const inv = (overrides: Partial<AgentInvocation> = {}): AgentInvocation => ({
  id: AgentInvocationId('inv-1'),
  runId: RunId('r1'),
  phaseId: PhaseName('plan-design'),
  profile: AgentProfileName('p'),
  runtime: 'opencode',
  provider: 'a',
  model: 'm',
  promptPath: '/p',
  promptChars: 1,
  stdoutPath: '/s',
  stderrPath: '/e',
  startedAt: new Date(),
  startCommitSha: 'a'.repeat(40),
  timeoutMs: 1000,
  resultJsonPath: 'result.json',
  ...overrides,
});

describe('extractResult', () => {
  it('returns typed result on valid input', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write(
      { runId: 'r1', phase: 'plan-design', type: 'result', path: 'result.json' },
      JSON.stringify({ result: 'ready', summary: 'go' }),
    );
    const r = await extractResult({
      invocation: inv(),
      ports: { artifacts, agent: new FakeAgentPort() },
    });
    expect(r).toEqual({ ok: true, result: { result: 'ready', summary: 'go' } });
  });
});
```

- [ ] **Step 2: Implement minimal version (parses + returns):**

```ts
import type { AgentInvocation } from '@ai-sdlc/domain';
import { PHASE_RESULT_REGISTRY } from './phase-registry.js';
import type { ArtifactStore, AgentPort } from '../ports.js';

export type ExtractResultOutcome<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; reason: 'missing' | 'invalid'; detail: string };

export interface ExtractResultInput {
  invocation: AgentInvocation;
  ports: { artifacts: ArtifactStore; agent: AgentPort };
}

export async function extractResult(input: ExtractResultInput): Promise<ExtractResultOutcome> {
  const { invocation, ports } = input;
  const meta = PHASE_RESULT_REGISTRY[invocation.phaseId];
  if (!meta) throw new Error(`no result schema registered for phase '${invocation.phaseId}'`);
  if (!invocation.resultJsonPath) {
    return { ok: false, reason: 'missing', detail: 'no resultJsonPath on invocation' };
  }
  try {
    const raw = await ports.artifacts.read(invocation.resultJsonPath);
    const parsed = meta.schema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return { ok: false, reason: 'invalid', detail: parsed.error.message };
    }
    return { ok: true, result: parsed.data };
  } catch (e) {
    return { ok: false, reason: 'missing', detail: String((e as Error).message) };
  }
}
```

- [ ] **Step 3: Run, expect pass.**
- [ ] **Step 4: Commit.**

### Task 3: extractResult — rerun branch

**Files:** modify `extract-result.ts`, extend test.

- [ ] **Step 1: Failing test** — missing `result.json`, `retrySafe: true`. After extraction, expect: exactly one rerun on `FakeAgentPort` (assert call count), result returns ok or fail depending on what the rerun produces. Use the fake's scripted-response feature.
- [ ] **Step 2: Implement** — after the initial fail, when `meta.retrySafe`, call `ports.agent.invoke(buildRetryRequest(invocation))` exactly once. The retry request carries `fallbackOfInvocationId: invocation.id` and a prepended "the previous invocation did not produce a valid result.json; please write it before exiting" note (via the prompt path — for now, just pass the request through; refining the rerun prompt is a future M8 concern).
- [ ] **Step 3: Add a `dispatchCount` check.** Track on the fake (already does — `FakeAgentPort` is from M3-06; if not, add a counter).
- [ ] **Step 4: Run, commit.**

### Task 4: extractResult — still-invalid + retrySafe=false

- [ ] **Step 1: Failing tests** for branches (c) still-invalid after rerun → `{ ok: false, reason: 'invalid' }` with **no** third call, and (d) `retrySafe: false` → fail immediately, no rerun.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run, commit.**

### Task 5: Add remaining 6 phase schemas + registry entries

For each of `plan-write`, `implement`, `review`, `fix-review`, `create-pr`, `pr-review-poll`:

- [ ] **Step 1: Search the repo for captured `result.json` examples** under `.ai-runs/`, `ai/issues/`, `ai/poll-pr-*/`, or git history. If at least one example exists, lift its shape verbatim. If none exists, use the illustrative shape from the issue spec and document the assumption at the top of the schema file (`// No captured example available; shape inferred from M8 phase intent`).
- [ ] **Step 2: Write the Zod schema + register it.**
- [ ] **Step 3: Add a fixture under `__fixtures__/result-json/<phase>/valid.json`.**
- [ ] **Step 4: Extend the parameterised test** to cover the four branches for this phase.
- [ ] **Step 5: Commit one phase per task** (six commits total).

### Task 6: Diagnostic helper

**Files:** `apps/cli/src/diagnose-result.ts`

- [ ] **Step 1: Implement a small CLI:**

```ts
#!/usr/bin/env node
// DIAGNOSTIC ONLY — not wired into production paths.
// Reads result.json by path, parses against the phase registry, prints the
// parse result. Operator use only.

import { readFileSync } from 'node:fs';
import { PHASE_RESULT_REGISTRY } from '@ai-sdlc/application';

const [, , phase, path] = process.argv;
if (!phase || !path) {
  console.error('usage: diagnose-result <phase> <path-to-result.json>');
  process.exit(2);
}
const meta = PHASE_RESULT_REGISTRY[phase];
if (!meta) {
  console.error(`unknown phase: ${phase}`);
  process.exit(2);
}
const raw = readFileSync(path, 'utf-8');
const result = meta.schema.safeParse(JSON.parse(raw));
if (result.success) {
  console.log('OK', JSON.stringify(result.data, null, 2));
} else {
  console.error('FAIL', result.error.message);
  process.exit(1);
}
```

- [ ] **Step 2: Commit.**

### Task 7: Grep-based no-LLM test

**Files:** `packages/application/src/__tests__/no-llm-in-extract.test.ts`

- [ ] **Step 1: Implement:**

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'results', 'extract-result.ts');

describe('extract-result.ts uses AgentPort at most once', () => {
  it('contains exactly one call to ports.agent.invoke', () => {
    const src = readFileSync(SRC, 'utf-8');
    const matches = src.match(/ports\.agent\.invoke\s*\(/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Commit.**

### Task 8: Final verification

- [ ] `pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm depcruise`. All pass.
- [ ] Stop.

---

## Story M4-06 — Replace agent calls in Bash review/plan/PR phases

**GitHub issue:** #96. **Depends on:** M4-02, M4-02c, M4-03, M4-04. **Closes #27.**

### File structure

- Create: `apps/cli/src/run-agent.ts` — new CLI entry.
- Modify: `apps/cli/package.json` — add bin entry, build script.
- Modify: `scripts/ai-run-issue-v2` — swap `opencode` calls for `node apps/cli/dist/run-agent.js`.
- Modify: `scripts/ai-pr-review-poll` — same.
- Tests:
  - `apps/cli/src/__tests__/run-agent.test.ts` — flag parsing.
  - `apps/cli/src/__tests__/run-agent-integration.test.ts` — fake-adapter end-to-end.

### Task 1: CLI scaffolding

**Files:** `apps/cli/src/run-agent.ts`, `apps/cli/package.json`.

- [ ] **Step 1: Confirm `apps/cli` exists.** If not, create it as a workspace package mirroring `apps/api`'s `package.json` (tsconfig, vitest config). Add to `pnpm-workspace.yaml` if missing.

- [ ] **Step 2: Implement minimal CLI** — `apps/cli/src/run-agent.ts`:

```ts
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { composeRoot } from '@ai-sdlc/api/compose.js'; // or extract a leaner composer
import { AgentProfileName, PhaseName, RunId } from '@ai-sdlc/domain';
import { ConfigError } from '@ai-sdlc/shared';

interface Flags {
  phase?: string;
  profile?: string;
  cwd?: string;
  'run-id'?: string;
  'repo-id'?: string;
  'phase-id'?: string;
  'step-id'?: string;
  'prompt-file'?: string;
  'expected-artifacts'?: string;
  'timeout-minutes'?: string;
}

async function main() {
  const { values } = parseArgs({
    options: {
      phase: { type: 'string' },
      profile: { type: 'string' },
      cwd: { type: 'string' },
      'run-id': { type: 'string' },
      'repo-id': { type: 'string' },
      'phase-id': { type: 'string' },
      'step-id': { type: 'string' },
      'prompt-file': { type: 'string' },
      'expected-artifacts': { type: 'string' },
      'timeout-minutes': { type: 'string' },
    },
    allowPositionals: false,
  }) as { values: Flags };

  if (
    !values.cwd ||
    !values['run-id'] ||
    !values['repo-id'] ||
    !values['phase-id'] ||
    !values['prompt-file']
  ) {
    console.error('missing required flag (cwd, run-id, repo-id, phase-id, prompt-file)');
    process.exit(2);
  }

  const c = composeRoot({
    repoRoot: process.cwd(),
    scriptPath: '/dev/null', // unused by run-agent
  });
  if (!c.agentRuntime) {
    console.error('agent runtime not configured in .ai-orchestrator.json');
    process.exit(2);
  }

  let profileName: string;
  if (values.profile) {
    if (!c.config?.agent?.profiles[values.profile]) {
      console.error(`unknown profile: ${values.profile}`);
      process.exit(2);
    }
    profileName = values.profile;
  } else if (values.phase) {
    const entry = c.config?.agent?.phaseProfiles[values.phase];
    if (!entry) {
      console.error(`unknown phase: ${values.phase} (no entry in agent.phaseProfiles)`);
      process.exit(2);
    }
    profileName = entry.profile;
  } else {
    console.error('must pass --phase or --profile');
    process.exit(2);
  }

  const expectedArtifacts = values['expected-artifacts']?.split(',').filter(Boolean) ?? [];
  try {
    const result = await c.agentRuntime.invoke({
      profile: AgentProfileName(profileName),
      promptPath: values['prompt-file']!,
      expectedArtifacts,
      cwd: values.cwd!,
      runId: values['run-id']!,
      repoId: values['repo-id']!,
      phaseId: values['phase-id']!,
      stepId: values['step-id'],
      startCommitSha: '0'.repeat(40), // caller computes via git rev-parse HEAD in Bash; pass via --start-sha
    });
    if (result.outcome === 'success') process.exit(0);
    if (result.outcome === 'timeout') process.exit(2);
    if (result.outcome === 'contract_violation') process.exit(1);
    process.exit(3);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(2);
    }
    console.error(e);
    process.exit(3);
  }
}

void main();
```

> Note: `composeRoot` returns a `Container`. If `Container` does not currently expose `config`, add it in M4-06's first task — `config: OrchestratorConfig`.

- [ ] **Step 3: Add `--start-sha` flag** instead of hard-coded zeros, and have Bash callers compute via `git rev-parse HEAD`.

- [ ] **Step 4: Commit** — `M4-06(cli): scaffold run-agent CLI`.

### Task 2: Unit tests for flag parsing

- [ ] **Step 1: Write unit tests** that import `main` (refactor to allow injection of args + a stub `Container`). Cover: missing required flag → exit 2; unknown phase → exit 2; unknown profile → exit 2; ambiguous (--phase + --profile both unset) → exit 2.
- [ ] **Step 2: Run, expect pass.**
- [ ] **Step 3: Commit.**

### Task 3: Integration test with fake adapter

- [ ] **Step 1: Write a test** that wires a `FakeAgentPort` into a custom `Container` and invokes the CLI's main with arguments pointing at a temp prompt file. Assert: process exit code matches expected outcome; one row in the fake invocation port.
- [ ] **Step 2: Commit.**

### Task 4: Migrate Bash invocations for `plan-design`

**Files:** `scripts/ai-run-issue-v2`.

- [ ] **Step 1: Locate the `opencode run ...` call for `plan-design`** (grep for `opencode` in the script).
- [ ] **Step 2: Replace** with:
  ```sh
  node "$REPO_ROOT/apps/cli/dist/run-agent.js" \
    --phase plan-design \
    --cwd "$WORKTREE" \
    --run-id "$RUN_ID" \
    --repo-id "$REPO_ID" \
    --phase-id plan-design \
    --prompt-file "$PROMPT_FILE" \
    --start-sha "$(git -C "$WORKTREE" rev-parse HEAD)"
  ```
- [ ] **Step 3: Make sure `apps/cli` builds before the script runs** — add `pnpm --filter @ai-sdlc/cli build` to the orchestrator bootstrap (or document the prerequisite if bootstrap is out of scope here).
- [ ] **Step 4: Commit.**

### Task 5: Migrate `plan-write`, `review`, `fix-review`, `create-pr`, `pr-review-poll`

Repeat the pattern from Task 4 for each. **One commit per phase.** Confirm each call still passes its existing prompt file path and the script picks up the right `RUN_ID` / `REPO_ID` env vars.

### Task 6: Document the gap

- [ ] **Step 1: Update the header comment** of `scripts/ai-run-issue-v2` to record:
  - "The `implement` loop still spawns `opencode` directly. That migration is M8-04. Do not assume all agent calls flow through the Node CLI."
- [ ] **Step 2: Commit.**

### Task 7: End-to-end smoke test (manual or scripted)

- [ ] **Step 1:** Run `pnpm -r build && scripts/ai-run-issue-v2 <test-issue-number>` against a non-destructive issue.
- [ ] **Step 2:** Inspect the SQLite database: 5 new `agent_invocations` rows (one per migrated phase) with `runtime`, `provider`, `model`, profile name populated.
- [ ] **Step 3:** If the run fails, fix the migration and re-run. If end-to-end is not feasible in CI, document the manual verification step in the PR description.
- [ ] **Step 4: Commit any fixes.**

### Task 8: Final verification

- [ ] `pnpm -r typecheck && pnpm -r test && pnpm lint && pnpm depcruise`. All pass.
- [ ] Manually grep `scripts/` for any remaining direct `opencode run` calls outside the `implement` loop. Confirm none remain.
- [ ] Stop.

---

## Story ordering / execution sequence (autonomous loop)

Execute in this order — each story's PR must merge before the next starts:

1. **M4-01** (#89) — foundation. No M4 dependencies.
2. **M4-02** (#90) — depends on M4-01; introduces shared `contract-violation-codes.ts`.
3. **M4-02b** (#91) — depends on M4-02.
4. **M4-02c** (#92) — depends on M4-02, M4-02b.
5. **M4-03** (#93) — depends on M4-02. **Can run in parallel with M4-02c**, but not before M4-02.
6. **M4-04** (#94) — depends on M4-02 (uses violation codes). Can run in parallel with M4-03 / M4-02c.
7. **M4-05** (#95) — depends on M4-04 (validator + violation codes) and M4-02c (fallback protocol). Must wait for both.
8. **M4-06** (#96) — depends on everything above. Final story.

If running serial only, the safe order is: M4-01 → M4-02 → M4-02b → M4-02c → M4-03 → M4-04 → M4-05 → M4-06.
