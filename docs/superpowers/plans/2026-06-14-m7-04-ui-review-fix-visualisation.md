# M7-04: UI — Review/Fix Loop Visualisation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Review/Fix" tab on the run-detail page that renders each persisted loop's iterations (review/fix/revalidate outcomes) with a convergence/exhaustion badge, backed by a new `GET /api/runs/:uuid/review-fix` endpoint.

**Architecture:** Four-part shape copied from the M6-06 PR-review tab: (1) a Fastify route in `apps/api` reading `loopRepository.listForRun`; (2) a typed client + DTO in `apps/web/src/lib`; (3) a `ReviewFixPanel` client component; (4) tab registration in `RunDetailTabs`. Plus a Playwright e2e.

**Tech Stack:** Fastify, Next.js 15 (App Router), React, Tailwind, Vitest, Playwright. Depends on **#336 (M7-02)** (which adds `loopRepository` to the Container and persists loops). GitHub issue: **#338**.

---

## Background the engineer must know

- **Copy these as templates** (read first):
  - API route: `apps/api/src/routes/pr-review.ts` (and `routes/validation.ts` for the simpler `listForRun`-style shape). Registration: `apps/api/src/server.ts`.
  - Web client + DTO + sort helper: `apps/web/src/lib/api-client.ts` (`listPrReview`/`listValidation`) and `apps/web/src/lib/pr-review.ts`.
  - Panel: `apps/web/src/components/PrReviewPanel.tsx` and `apps/web/src/components/ValidationPanel.tsx`.
  - Tab registration: `apps/web/src/components/RunDetailTabs.tsx` (`TAB_ITEMS` + conditional render).
  - e2e: `apps/web/e2e/pr-review-tab.spec.ts`, `apps/web/e2e/run-detail-timeline.spec.ts`, and `apps/web/e2e/globalSetup.ts` (seeding).
- **The Container already exposes `loopRepository`** (added by #336). The route calls `c.loopRepository.listForRun(RunId(uuid))` and serialises.
- **Domain `Loop` shape** (from #335): `{ id, runId, phaseId, type, maxIterations, status: 'running'|'converged'|'exhausted'|'failed', startedAt, completedAt?, iterations: LoopIteration[] }`; `LoopIteration { index, reviewInvocationId, fixInvocationId?, revalidationId?, outcome?: 'resolved'|'fixed'|'unresolved'|'failed', startedAt, completedAt? }`.
- **Empty state matters:** runs that never entered review/fix must render cleanly (route returns `{ loops: [] }`).
- **The web client picks base URL** with `typeof window === 'undefined' ? apiUrl : ''` — copy this exactly from `listPrReview`.
- **Run commands from repo root** `/home/gary/.openclaw/workspace/automation`. Web e2e: `pnpm --filter @ai-sdlc/web test:e2e` (confirm the exact script in `apps/web/package.json`).

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/api/src/routes/review-fix.ts` (create) | `GET /api/runs/:uuid/review-fix` → `{ loops: LoopDto[] }`. |
| `apps/api/src/server.ts` (modify) | Register the route. |
| `apps/api/src/__tests__/review-fix-route.test.ts` (create) | Route returns seeded loops + `[]` for empty. |
| `apps/web/src/lib/review-fix.ts` (create) | `LoopDto`/`LoopIterationDto` types + badge/chip helpers. |
| `apps/web/src/lib/api-client.ts` (modify) | `listReviewFix(runUuid)`. |
| `apps/web/src/lib/__tests__/review-fix.test.ts` (create) | Helper unit tests. |
| `apps/web/src/components/ReviewFixPanel.tsx` (create) | The tab body. |
| `apps/web/src/components/RunDetailTabs.tsx` (modify) | Add the "Review/Fix" tab. |
| `apps/web/e2e/review-fix-tab.spec.ts` (create) | e2e: converging + exhausting loops render. |

---

## Task 1: API route `GET /api/runs/:uuid/review-fix`

**Files:**
- Create: `apps/api/src/routes/review-fix.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/__tests__/review-fix-route.test.ts`

- [ ] **Step 1: Write the failing route test**

Create `apps/api/src/__tests__/review-fix-route.test.ts` (model it on the existing pr-review route test — find it under `apps/api/src/__tests__/` and copy its Fastify-injection harness and DB seeding helper):

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunId, PhaseName, createLoop, startIteration, completeIteration } from '@ai-sdlc/domain';
import { buildServer } from '../server.js';
import { composeRoot } from '../compose.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'm7-rf-route-'));
  const c = composeRoot({ repoRoot: dir, scriptPath: '/dev/null', runStartupSweeps: false });
  // Insert a run row, then a converged loop.
  c.runRepository.insert(
    /* createRun({ uuid: '...', displayId, issueNumber: 1, startedAt }) — copy from another api test */ undefined as never,
  );
  return c;
}

const UUID = '11111111-1111-1111-1111-111111111111';

describe('GET /api/runs/:uuid/review-fix', () => {
  it('returns [] for a run with no loops', async () => {
    const c = setup();
    const app = buildServer(c);
    const res = await app.inject({ method: 'GET', url: `/api/runs/${UUID}/review-fix` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ loops: [] });
  });

  it('returns a converged loop with its iterations', async () => {
    const c = setup();
    let loop = createLoop({
      id: 'loop-1',
      runId: RunId(UUID),
      phaseId: PhaseName('whole-pr-review'),
      type: 'review-fix',
      maxIterations: 3,
      now: new Date('2026-06-14T00:00:00.000Z'),
    });
    loop = completeIteration(startIteration(loop, { reviewInvocationId: 'r1', now: new Date() }), {
      outcome: 'resolved',
      now: new Date(),
    });
    c.loopRepository.insert(loop);

    const app = buildServer(c);
    const res = await app.inject({ method: 'GET', url: `/api/runs/${UUID}/review-fix` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { loops: Array<{ id: string; status: string; iterations: unknown[] }> };
    expect(body.loops).toHaveLength(1);
    expect(body.loops[0]?.status).toBe('converged');
    expect(body.loops[0]?.iterations).toHaveLength(1);
  });

  it('rejects an invalid uuid', async () => {
    const c = setup();
    const app = buildServer(c);
    const res = await app.inject({ method: 'GET', url: `/api/runs/not-a-uuid/review-fix` });
    expect(res.statusCode).toBe(400);
  });
});
```

> Resolve the real helpers: the exact server factory name (`buildServer` vs `createServer` — check `server.ts`), the `createRun` import + required fields, and how the existing pr-review route test seeds a run. Replace the `undefined as never` placeholder with a real `createRun({...})` whose `uuid` equals `UUID`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ai-sdlc/api test -- review-fix-route.test.ts`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Write the route**

Create `apps/api/src/routes/review-fix.ts` (mirror `validation.ts`):

```ts
import type { FastifyInstance } from 'fastify';
import { RunId } from '@ai-sdlc/domain';
import type { Container } from '../compose.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerReviewFixRoutes(app: FastifyInstance, c: Container): void {
  app.get<{ Params: { uuid: string } }>('/api/runs/:uuid/review-fix', async (req, reply) => {
    const { uuid } = req.params;
    if (!UUID_RE.test(uuid)) {
      reply.code(400);
      return { error: 'invalid run uuid' };
    }
    const loops = c.loopRepository.listForRun(RunId(uuid)).map((l) => ({
      id: l.id,
      phaseId: l.phaseId,
      type: l.type,
      status: l.status,
      maxIterations: l.maxIterations,
      startedAt: l.startedAt.toISOString(),
      completedAt: l.completedAt?.toISOString() ?? null,
      iterations: l.iterations.map((it) => ({
        index: it.index,
        outcome: it.outcome ?? null,
        reviewInvocationId: it.reviewInvocationId,
        fixInvocationId: it.fixInvocationId ?? null,
        revalidationId: it.revalidationId ?? null,
        startedAt: it.startedAt.toISOString(),
        completedAt: it.completedAt?.toISOString() ?? null,
      })),
    }));
    return { loops };
  });
}
```

- [ ] **Step 4: Register the route in `server.ts`**

Edit `apps/api/src/server.ts`:
- Add import alongside the others: `import { registerReviewFixRoutes } from './routes/review-fix.js';`
- Add the call next to `registerPrReviewRoutes(app, container);`: `registerReviewFixRoutes(app, container);`

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @ai-sdlc/api test -- review-fix-route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/review-fix.ts apps/api/src/server.ts apps/api/src/__tests__/review-fix-route.test.ts
git commit -m "feat(api): GET /api/runs/:uuid/review-fix (M7-04, #338)"
```

---

## Task 2: Web client + DTO + presentation helpers

**Files:**
- Create: `apps/web/src/lib/review-fix.ts`
- Modify: `apps/web/src/lib/api-client.ts`
- Test: `apps/web/src/lib/__tests__/review-fix.test.ts`

- [ ] **Step 1: Write the failing helper test**

Create `apps/web/src/lib/__tests__/review-fix.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loopBadge, iterationChip, type LoopDto } from '../review-fix.js';

describe('loopBadge', () => {
  it('maps status to label + tone', () => {
    expect(loopBadge('converged').tone).toBe('green');
    expect(loopBadge('exhausted').tone).toBe('red');
    expect(loopBadge('failed').tone).toBe('red');
    expect(loopBadge('running').tone).toBe('blue');
  });
});

describe('iterationChip', () => {
  it('maps outcome to tone', () => {
    expect(iterationChip('resolved').tone).toBe('green');
    expect(iterationChip('fixed').tone).toBe('blue');
    expect(iterationChip('unresolved').tone).toBe('amber');
    expect(iterationChip('failed').tone).toBe('red');
    expect(iterationChip(null).tone).toBe('slate'); // open/in-progress iteration
  });
});

it('LoopDto type compiles', () => {
  const l: LoopDto = {
    id: 'l1',
    phaseId: 'whole-pr-review',
    type: 'review-fix',
    status: 'converged',
    maxIterations: 3,
    startedAt: '2026-06-14T00:00:00.000Z',
    completedAt: null,
    iterations: [],
  };
  expect(l.id).toBe('l1');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ai-sdlc/web test -- review-fix.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the lib**

Create `apps/web/src/lib/review-fix.ts`:

```ts
export interface LoopIterationDto {
  index: number;
  outcome: 'resolved' | 'fixed' | 'unresolved' | 'failed' | null;
  reviewInvocationId: string;
  fixInvocationId: string | null;
  revalidationId: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface LoopDto {
  id: string;
  phaseId: string;
  type: 'review-fix' | 'implement-step';
  status: 'running' | 'converged' | 'exhausted' | 'failed';
  maxIterations: number;
  startedAt: string;
  completedAt: string | null;
  iterations: LoopIterationDto[];
}

export type Tone = 'green' | 'red' | 'blue' | 'amber' | 'slate';

const BADGE: Record<LoopDto['status'], { label: string; tone: Tone }> = {
  running: { label: 'Running', tone: 'blue' },
  converged: { label: 'Converged', tone: 'green' },
  exhausted: { label: 'Exhausted', tone: 'red' },
  failed: { label: 'Failed', tone: 'red' },
};

export function loopBadge(status: LoopDto['status']): { label: string; tone: Tone } {
  return BADGE[status];
}

const CHIP: Record<NonNullable<LoopIterationDto['outcome']>, { label: string; tone: Tone }> = {
  resolved: { label: 'resolved', tone: 'green' },
  fixed: { label: 'fixed', tone: 'blue' },
  unresolved: { label: 'unresolved', tone: 'amber' },
  failed: { label: 'failed', tone: 'red' },
};

export function iterationChip(outcome: LoopIterationDto['outcome']): { label: string; tone: Tone } {
  return outcome === null ? { label: 'running', tone: 'slate' } : CHIP[outcome];
}
```

- [ ] **Step 4: Add the client fetcher to `api-client.ts`**

Edit `apps/web/src/lib/api-client.ts` — add (after `listPrReview`), importing the DTO type at the top: `import type { LoopDto } from './review-fix';`

```ts
export async function listReviewFix(runUuid: string): Promise<LoopDto[]> {
  const base = typeof window === 'undefined' ? apiUrl : '';
  const r = await fetch(`${base}/api/runs/${runUuid}/review-fix`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load review-fix: ${r.status}`);
  return ((await r.json()) as { loops: LoopDto[] }).loops;
}
```

> Confirm the `apiUrl` symbol name in `api-client.ts` (it is used by `listPrReview`); reuse it verbatim.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm --filter @ai-sdlc/web test -- review-fix.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/review-fix.ts apps/web/src/lib/api-client.ts apps/web/src/lib/__tests__/review-fix.test.ts
git commit -m "feat(web): review-fix API client + DTO + helpers (M7-04, #338)"
```

---

## Task 3: ReviewFixPanel component

**Files:**
- Create: `apps/web/src/components/ReviewFixPanel.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/ReviewFixPanel.tsx` (mirror the loading/empty/error pattern of `PrReviewPanel.tsx`; reuse the existing `ArtifactViewer` for linking invocation artifacts if a runtime-relative path is available — otherwise show the invocation id as plain text):

```tsx
'use client';

import { useEffect, useState } from 'react';
import { listReviewFix } from '@/lib/api-client';
import { loopBadge, iterationChip, type LoopDto, type Tone } from '@/lib/review-fix';

const TONE_CLASS: Record<Tone, string> = {
  green: 'bg-green-100 text-green-800',
  red: 'bg-red-100 text-red-800',
  blue: 'bg-blue-100 text-blue-800',
  amber: 'bg-amber-100 text-amber-800',
  slate: 'bg-slate-100 text-slate-600',
};

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}>{children}</span>;
}

export function ReviewFixPanel({ runUuid }: { runUuid: string }) {
  const [loops, setLoops] = useState<LoopDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listReviewFix(runUuid)
      .then((d) => live && setLoops(d))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [runUuid]);

  if (error) return <div className="text-sm text-red-600">Failed to load review/fix: {error}</div>;
  if (loops === null) return <div className="text-sm text-slate-500">Loading review/fix…</div>;
  if (loops.length === 0)
    return <div className="text-sm text-slate-500">No review/fix activity for this run.</div>;

  return (
    <div className="space-y-4">
      {loops.map((loop) => {
        const badge = loopBadge(loop.status);
        return (
          <div key={loop.id} className="rounded border p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="font-medium">{loop.phaseId}</span>
              <Pill tone={badge.tone}>{badge.label}</Pill>
              <span className="text-xs text-slate-500">
                {loop.iterations.length} / {loop.maxIterations} iterations
              </span>
            </div>
            <ul className="space-y-1">
              {loop.iterations.map((it) => {
                const chip = iterationChip(it.outcome);
                return (
                  <li key={it.index} className="flex items-center gap-3 text-sm">
                    <span className="w-20 text-slate-500">Iteration {it.index}</span>
                    <Pill tone={chip.tone}>{chip.label}</Pill>
                    <span className="text-xs text-slate-500">review: {it.reviewInvocationId}</span>
                    {it.fixInvocationId && (
                      <span className="text-xs text-slate-500">fix: {it.fixInvocationId}</span>
                    )}
                    {it.revalidationId && (
                      <span className="text-xs text-slate-500">revalidate: {it.revalidationId}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Type-check the web package**

Run: `pnpm --filter @ai-sdlc/web build` (or the project's typecheck script, e.g. `pnpm --filter @ai-sdlc/web exec tsc --noEmit`)
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/ReviewFixPanel.tsx
git commit -m "feat(web): ReviewFixPanel component (M7-04, #338)"
```

---

## Task 4: Register the "Review/Fix" tab

**Files:**
- Modify: `apps/web/src/components/RunDetailTabs.tsx`

- [ ] **Step 1: Add the tab**

Edit `apps/web/src/components/RunDetailTabs.tsx`:
1. Import the panel near the other panel imports:
   ```tsx
   import { ReviewFixPanel } from './ReviewFixPanel';
   ```
2. Add to `TAB_ITEMS`, placed between `validation` and `pr-review`:
   ```ts
   { id: 'review-fix', label: 'Review/Fix' },
   ```
3. Add the conditional render next to the validation/pr-review blocks:
   ```tsx
   {activeTab === 'review-fix' && <ReviewFixPanel runUuid={run.uuid} />}
   ```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @ai-sdlc/web build`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/RunDetailTabs.tsx
git commit -m "feat(web): add Review/Fix tab to run detail (M7-04, #338)"
```

---

## Task 5: Playwright e2e

**Files:**
- Create: `apps/web/e2e/review-fix-tab.spec.ts`

- [ ] **Step 1: Study the seeding harness**

Read `apps/web/e2e/pr-review-tab.spec.ts` and `apps/web/e2e/globalSetup.ts`. Note how they seed the SQLite DB the API serves from (which `openDatabase`/migrations + repository inserts they use) and how they navigate to `/runs/<uuid>` and click a tab.

- [ ] **Step 2: Write the e2e**

Create `apps/web/e2e/review-fix-tab.spec.ts`. Seed one **converged** loop and one **exhausted** loop for a run, then assert both badges and their iteration rows render. Structure (use the real seeding helper from `globalSetup.ts`/`pr-review-tab.spec.ts`):

```ts
import { test, expect } from '@playwright/test';
// import the same seed helpers the pr-review-tab spec uses

test.describe('Review/Fix tab', () => {
  test('renders converged and exhausted loops', async ({ page }) => {
    // 1. Seed run RUN_UUID with:
    //    - loop A: status 'converged', 1 iteration outcome 'resolved'
    //    - loop B: status 'exhausted', 2 iterations outcome 'unresolved'
    //    (build with createLoop/startIteration/completeIteration/exhaust + loopRepository.insert,
    //     exactly like the route test in Task 1)
    await page.goto(`/runs/${'RUN_UUID'}`);
    await page.getByRole('tab', { name: 'Review/Fix' }).click(); // adjust selector to the Tabs impl

    await expect(page.getByText('Converged')).toBeVisible();
    await expect(page.getByText('Exhausted')).toBeVisible();
    await expect(page.getByText('Iteration 1')).toBeVisible();
    await expect(page.getByText('resolved')).toBeVisible();
  });

  test('shows empty state for a run with no loops', async ({ page }) => {
    await page.goto(`/runs/${'EMPTY_RUN_UUID'}`);
    await page.getByRole('tab', { name: 'Review/Fix' }).click();
    await expect(page.getByText('No review/fix activity for this run.')).toBeVisible();
  });
});
```

> Match the tab-click selector to how `Tabs.tsx` renders tabs (button vs role="tab"); copy the exact selector style from `pr-review-tab.spec.ts`.

- [ ] **Step 3: Run the e2e**

Run: `pnpm --filter @ai-sdlc/web test:e2e -- review-fix-tab.spec.ts` (confirm the exact e2e script name in `apps/web/package.json`)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/review-fix-tab.spec.ts
git commit -m "test(web): e2e for Review/Fix tab (M7-04, #338)"
```

---

## Task 6: Full verification

- [ ] **Step 1: Build, test, lint, e2e**

Run: `pnpm -r build && pnpm -r test && pnpm -r lint`
Then: `pnpm --filter @ai-sdlc/web test:e2e`
Expected: all green.

---

## Self-Review checklist (run before handoff)

- [ ] Issue #338 acceptance mapped: route returns DTO + `[]` for empty (T1) ✔; panel renders multiple loops/iterations + badges + chips (T3) ✔; empty/loading states (T3) ✔; tab appears (T4) ✔; e2e for converging + exhausting + empty (T5) ✔; DTO parsing test (T2) ✔; green CI + e2e (T6) ✔.
- [ ] No phase rename in `timeline.ts` (that is M8-06) — this story only adds a tab.
- [ ] Type names consistent: `LoopDto`, `LoopIterationDto`, `listReviewFix`, `loopBadge`, `iterationChip`, `ReviewFixPanel`, `registerReviewFixRoutes`.
- [ ] No placeholders committed — the `undefined as never` in the Task 1 test skeleton and the `RUN_UUID`/seed comments in the e2e MUST be replaced with real values before committing.
- [ ] Status/outcome strings match the domain: loop status `running|converged|exhausted|failed`; iteration outcome `resolved|fixed|unresolved|failed|null`.
```
