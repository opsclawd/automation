# M5-04: Validation UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Validation" tab to the run-detail page that shows each command as a card (command, status pill, kind badge, duration) with failing/timed-out commands sorted to the top, and expandable per-command stdout/stderr.

**Architecture:** A read-only API endpoint `GET /api/runs/:uuid/validation` (mirrors the existing invocations route) serializes persisted `ValidationRun`s. The web app gets a `listValidation` client + a pure `sortCommandsFailingFirst` helper (unit-tested in `lib/`, matching the repo's `lib/timeline.ts` pattern) and a thin client component `ValidationPanel` that self-fetches on mount (like `TimelineIsland`) and reuses the existing `ArtifactViewer` for log output.

**Tech Stack:** Fastify (API), Next.js 15 App Router + Tailwind (web), Vitest. Note: the web app has **no** React Testing Library — UI logic is tested as pure functions in `lib/`; the component is verified by typecheck/build and the optional Playwright e2e.

---

## Background the engineer needs

- **Depends on M5-01/M5-02** (merged): `c.validationRunRepository.listByRun(runId)` returns `ValidationRun[]`; records have `kind`/`classifier` once M5-03 is merged (treat them as possibly-undefined in the UI regardless).
- **API route pattern to copy:** `apps/api/src/routes/invocations.ts` (`registerInvocationsRoutes`) — UUID validation with `UUID_RE`, `400` on bad id, `c.<repo>.listByRun(RunId(uuid))`, map to a lean DTO. Registered in `apps/api/src/server.ts` via `registerInvocationsRoutes(app, container)`.
- **API test pattern:** `apps/api/src/__tests__/invocations-api.test.ts` — `composeRoot({ dbPath: ':memory:', ... })`, seed via repositories, `buildServer(c)`, `app.inject({ url })`.
- **Artifact serving:** files under a run live at `GET /api/runs/:uuid/artifacts/*`. The validation log paths are run-relative (`validate/0-build.stdout.log`). `ArtifactViewer` (`apps/web/src/components/ArtifactViewer.tsx`) already fetches `/api/runs/${runId}/artifacts/${encodeURIComponent(fileName)}`, previews `.log` files, and is what the Artifacts tab uses for nested `phases/...` paths — so it works as-is for `validate/...` paths.
- **Tabs:** `apps/web/src/components/RunDetailTabs.tsx` holds `TAB_ITEMS` and renders each tab's content. `Tabs` is a controlled component.
- **Self-fetching island pattern:** `apps/web/src/app/runs/[id]/timeline-island.tsx` fetches by `runUuid` on the client. Mirror it.
- **api-client dual-origin:** `apps/web/src/lib/api-client.ts` — server components hit `apiUrl`, client components use relative `/api/...`. `listRunEvents` shows the `typeof window === 'undefined' ? apiUrl : ''` idiom; reuse it.
- **format helpers:** `apps/web/src/lib/format.ts` has `formatDuration(ms)`.
- **Run commands:** API tests `pnpm vitest run apps/api/...`; web lib tests `pnpm vitest run apps/web/...`; web build `pnpm --filter @ai-sdlc/web build`; full `pnpm -r build && pnpm -r typecheck && pnpm test && pnpm lint`.

## File Structure

- **Create** `apps/api/src/routes/validation.ts` — `registerValidationRoutes`.
- **Modify** `apps/api/src/server.ts` — register the route.
- **Create** `apps/api/src/__tests__/validation-api.test.ts`.
- **Create** `apps/web/src/lib/validation.ts` — DTO types + `sortCommandsFailingFirst`.
- **Create** `apps/web/src/lib/__tests__/validation.test.ts`.
- **Modify** `apps/web/src/lib/api-client.ts` — `listValidation`.
- **Create** `apps/web/src/components/ValidationPanel.tsx`.
- **Modify** `apps/web/src/components/RunDetailTabs.tsx` — add the tab.

---

## Task 1: API endpoint `GET /api/runs/:uuid/validation`

**Files:**

- Create: `apps/api/src/routes/validation.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/__tests__/validation-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/__tests__/validation-api.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { composeRoot } from '../compose.js';
import { buildServer } from '../server.js';
import { RunId, PhaseName, type ValidationRun } from '@ai-sdlc/domain';

function compose() {
  return composeRoot({
    repoRoot: process.cwd(),
    scriptPath: '/bin/true',
    dbPath: ':memory:',
    runsDir: '/tmp/runs-test-' + Math.random(),
  });
}

const RUN_UUID = '00000000-0000-0000-0000-0000000000aa';

function seedRunRow(c: ReturnType<typeof compose>) {
  c.runRepository.insertIfNoActive({
    uuid: RUN_UUID,
    displayId: 'run-aa',
    issueNumber: 11,
    type: 'issue',
    status: 'running',
    completedPhases: [],
    startedAt: new Date(),
  } as never);
}

function sampleValidationRun(): ValidationRun {
  return {
    id: 'vr-aa',
    runId: RunId(RUN_UUID),
    phaseId: PhaseName('validate'),
    startedAt: new Date('2026-05-28T10:00:00Z'),
    completedAt: new Date('2026-05-28T10:00:30Z'),
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

describe('GET /api/runs/:uuid/validation', () => {
  it('returns serialized validation runs newest-first', async () => {
    const c = compose();
    seedRunRow(c);
    c.validationRunRepository.save(sampleValidationRun());
    const app = await buildServer(c);
    const res = await app.inject({ url: `/api/runs/${RUN_UUID}/validation` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { validationRuns: Array<Record<string, unknown>> };
    expect(body.validationRuns).toHaveLength(1);
    const vr = body.validationRuns[0] as any;
    expect(vr.passed).toBe(false);
    expect(vr.commands).toHaveLength(2);
    expect(vr.commands[1]).toMatchObject({
      command: 'pnpm typecheck',
      kind: 'typecheck',
      outcome: 'failed',
      classifier: '12 errors',
    });
    // does not inline full output
    expect(vr.commands[1].stdout).toBeUndefined();
  });

  it('returns 400 for an invalid uuid', async () => {
    const c = compose();
    const app = await buildServer(c);
    const res = await app.inject({ url: '/api/runs/not-a-uuid/validation' });
    expect(res.statusCode).toBe(400);
  });

  it('returns empty array for a valid uuid with no data', async () => {
    const c = compose();
    const app = await buildServer(c);
    const res = await app.inject({
      url: '/api/runs/00000000-0000-0000-0000-0000000000bb/validation',
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { validationRuns: unknown[] }).validationRuns).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/api/src/__tests__/validation-api.test.ts`
Expected: FAIL — route not registered (404 / module missing).

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/validation.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { RunId, validationRunPassed } from '@ai-sdlc/domain';
import type { Container } from '../compose.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerValidationRoutes(app: FastifyInstance, c: Container): void {
  app.get<{ Params: { uuid: string } }>('/api/runs/:uuid/validation', async (req, reply) => {
    const { uuid } = req.params;
    if (!UUID_RE.test(uuid)) {
      reply.code(400);
      return { error: 'invalid run uuid' };
    }
    const runs = c.validationRunRepository.listByRun(RunId(uuid));
    // newest first
    const ordered = [...runs].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const validationRuns = ordered.map((v) => ({
      id: v.id,
      phaseId: v.phaseId,
      startedAt: v.startedAt.toISOString(),
      completedAt: v.completedAt?.toISOString() ?? null,
      passed: validationRunPassed(v),
      commands: v.commands.map((cmd) => ({
        command: cmd.command,
        kind: cmd.kind ?? null,
        outcome: cmd.outcome,
        exitCode: cmd.exitCode,
        durationMs: cmd.durationMs,
        stdoutPath: cmd.stdoutPath,
        stderrPath: cmd.stderrPath,
        classifier: cmd.classifier ?? null,
      })),
    }));
    return { validationRuns };
  });
}
```

- [ ] **Step 4: Register the route in server.ts**

In `apps/api/src/server.ts`:

1. Add the import:

```ts
import { registerValidationRoutes } from './routes/validation.js';
```

2. In `buildServer`, after `registerInvocationsRoutes(app, container);`, add:

```ts
registerValidationRoutes(app, container);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/api/src/__tests__/validation-api.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/validation.ts apps/api/src/server.ts apps/api/src/__tests__/validation-api.test.ts
git commit -m "feat(api): GET /api/runs/:uuid/validation endpoint (M5-04)"
```

---

## Task 2: Web DTOs, sort helper, and api-client

**Files:**

- Create: `apps/web/src/lib/validation.ts`
- Create: `apps/web/src/lib/__tests__/validation.test.ts`
- Modify: `apps/web/src/lib/api-client.ts`

- [ ] **Step 1: Write the failing test for the sort helper**

Create `apps/web/src/lib/__tests__/validation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sortCommandsFailingFirst, type ValidationCommandDto } from '../validation';

function cmd(command: string, outcome: ValidationCommandDto['outcome']): ValidationCommandDto {
  return {
    command,
    kind: null,
    outcome,
    exitCode: 0,
    durationMs: 1,
    stdoutPath: 'validate/x.stdout.log',
    stderrPath: 'validate/x.stderr.log',
    classifier: null,
  };
}

describe('sortCommandsFailingFirst', () => {
  it('moves failed and timed_out commands to the top, preserving relative order within groups', () => {
    const input = [
      cmd('a-pass', 'passed'),
      cmd('b-fail', 'failed'),
      cmd('c-pass', 'passed'),
      cmd('d-timeout', 'timed_out'),
    ];
    const out = sortCommandsFailingFirst(input).map((c) => c.command);
    expect(out).toEqual(['b-fail', 'd-timeout', 'a-pass', 'c-pass']);
  });

  it('does not mutate the input array', () => {
    const input = [cmd('a', 'passed'), cmd('b', 'failed')];
    sortCommandsFailingFirst(input);
    expect(input.map((c) => c.command)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run apps/web/src/lib/__tests__/validation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the lib module**

Create `apps/web/src/lib/validation.ts`:

```ts
export interface ValidationCommandDto {
  command: string;
  kind: string | null;
  outcome: 'passed' | 'failed' | 'timed_out';
  exitCode: number;
  durationMs: number;
  stdoutPath: string;
  stderrPath: string;
  classifier: string | null;
}

export interface ValidationRunDto {
  id: string;
  phaseId: string;
  startedAt: string;
  completedAt: string | null;
  passed: boolean;
  commands: ValidationCommandDto[];
}

/** Failing/timed-out commands first; stable within each group. */
export function sortCommandsFailingFirst(commands: ValidationCommandDto[]): ValidationCommandDto[] {
  const bad = commands.filter((c) => c.outcome !== 'passed');
  const good = commands.filter((c) => c.outcome === 'passed');
  return [...bad, ...good];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run apps/web/src/lib/__tests__/validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `listValidation` to the api-client**

In `apps/web/src/lib/api-client.ts`:

1. Add an import at the top (near `import type { ApiEvent } from './timeline';`):

```ts
import type { ValidationRunDto } from './validation';
```

2. Append this function at the end of the file:

```ts
export async function listValidation(runUuid: string): Promise<ValidationRunDto[]> {
  const base = typeof window === 'undefined' ? apiUrl : '';
  const r = await fetch(`${base}/api/runs/${runUuid}/validation`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load validation: ${r.status}`);
  return (await r.json()).validationRuns as ValidationRunDto[];
}
```

- [ ] **Step 6: Typecheck the web app**

Run: `pnpm --filter @ai-sdlc/web typecheck`
Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/validation.ts apps/web/src/lib/__tests__/validation.test.ts apps/web/src/lib/api-client.ts
git commit -m "feat(web): validation DTOs + sort helper + listValidation client (M5-04)"
```

---

## Task 3: `ValidationPanel` component + tab

**Files:**

- Create: `apps/web/src/components/ValidationPanel.tsx`
- Modify: `apps/web/src/components/RunDetailTabs.tsx`

- [ ] **Step 1: Implement the panel**

Create `apps/web/src/components/ValidationPanel.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { listValidation } from '@/lib/api-client';
import { sortCommandsFailingFirst, type ValidationRunDto } from '@/lib/validation';
import { formatDuration } from '@/lib/format';
import { ArtifactViewer } from './ArtifactViewer';

const PILL: Record<string, string> = {
  passed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  timed_out: 'bg-amber-100 text-amber-800',
};

export function ValidationPanel({ runUuid }: { runUuid: string }) {
  const [runs, setRuns] = useState<ValidationRunDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    let live = true;
    listValidation(runUuid)
      .then((r) => live && setRuns(r))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [runUuid]);

  if (error) return <div className="text-sm text-red-600">Failed to load validation: {error}</div>;
  if (runs === null) return <div className="text-sm text-slate-500">Loading validation…</div>;
  if (runs.length === 0)
    return <div className="text-sm text-slate-500">No validation data for this run.</div>;

  const run = runs[Math.min(selected, runs.length - 1)];
  const commands = sortCommandsFailingFirst(run.commands);

  return (
    <div className="space-y-4">
      {runs.length > 1 && (
        <label className="text-sm text-slate-600">
          Validation run:{' '}
          <select
            className="border rounded px-1 py-0.5"
            value={selected}
            onChange={(e) => setSelected(Number(e.target.value))}
          >
            {runs.map((r, i) => (
              <option key={r.id} value={i}>
                {new Date(r.startedAt).toLocaleString()} {r.passed ? '✓' : '✗'}
              </option>
            ))}
          </select>
        </label>
      )}

      <ul className="space-y-2">
        {commands.map((c) => (
          <li key={c.command} className="rounded border p-3 text-sm">
            <div className="flex items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${PILL[c.outcome] ?? ''}`}>
                {c.outcome}
              </span>
              {c.kind && (
                <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                  {c.kind}
                </span>
              )}
              <code className="font-mono">{c.command}</code>
              <span className="ml-auto text-slate-500">{formatDuration(c.durationMs)}</span>
            </div>
            {c.outcome !== 'passed' && c.classifier && (
              <pre className="mt-1 whitespace-pre-wrap text-xs text-red-700">{c.classifier}</pre>
            )}
            <div className="mt-2 flex flex-col gap-1">
              <ArtifactViewer runId={runUuid} fileName={c.stdoutPath} fileSize={0} />
              <ArtifactViewer runId={runUuid} fileName={c.stderrPath} fileSize={0} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

> `ArtifactViewer` lazily fetches file content only when the user clicks the filename (it starts in `'closed'` state), so output is not loaded until expanded. `fileSize={0}` is acceptable — the validation API does not return file sizes; the viewer only uses it for a label.

- [ ] **Step 2: Add the tab to RunDetailTabs**

In `apps/web/src/components/RunDetailTabs.tsx`:

1. Add the import:

```ts
import { ValidationPanel } from './ValidationPanel';
```

2. Add the tab to `TAB_ITEMS`, between `artifacts` and `failure`:

```ts
  { id: 'validation', label: 'Validation' },
```

3. Add the render branch (e.g. after the `artifacts` block):

```tsx
{
  activeTab === 'validation' && <ValidationPanel runUuid={run.uuid} />;
}
```

- [ ] **Step 3: Typecheck + build the web app**

Run: `pnpm --filter @ai-sdlc/web typecheck && pnpm --filter @ai-sdlc/web build`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/ValidationPanel.tsx apps/web/src/components/RunDetailTabs.tsx
git commit -m "feat(web): Validation tab on run detail (M5-04)"
```

---

## Task 4: Full verification

- [ ] **Step 1: Run the whole suite + checks**

Run: `pnpm -r build && pnpm -r typecheck && pnpm test && pnpm lint && pnpm depcruise`
Expected: all green. (`web-stays-out-of-server-layers` must stay clean — `ValidationPanel` imports only `@/lib/*` and components, never `@ai-sdlc/api`/`application`/`infrastructure`.)

- [ ] **Step 2 (optional): manual smoke**

If an end-to-end run with validation data exists, start the API + web (`pnpm --filter @ai-sdlc/api dev` and `pnpm --filter @ai-sdlc/web dev`), open a run detail page, click **Validation**, and confirm: separate cards for build/lint/typecheck/test, failing-first ordering, and that expanding a command loads its log.

---

## Self-review checklist (run before handoff)

- [ ] Spec coverage: endpoint ✔ (Task 1, no inlined output), separate cards w/ status+duration ✔ (Task 3), failing-first ✔ (Task 2 helper + Task 3), expandable lazy output ✔ (Task 3 via ArtifactViewer), empty state ✔ (Task 3), multiple runs select ✔ (Task 3), FR8 build/lint/typecheck/test separate ✔.
- [ ] Type consistency: `ValidationRunDto`/`ValidationCommandDto` identical between `lib/validation.ts` and the API response shape; `listValidation` returns `ValidationRunDto[]`; `outcome` union matches the domain (`passed|failed|timed_out`).
- [ ] No placeholders.
- [ ] Layering: web imports no server packages (depcruise clean).

## Out of scope (do NOT implement here)

- Producing/persisting/classifying validation data (M5-01/02/03).
- Re-running validation from the UI (M8 retry/resume).
- Live-streaming validation output during execution.
- Bash cutover (M5-05).
