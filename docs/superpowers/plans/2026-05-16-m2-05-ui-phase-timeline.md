# M2-05: UI Phase Timeline Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Timeline" tab to the run detail page (`apps/web/src/app/runs/[id]/page.tsx`) that renders a vertical list of the canonical phases with visual status (pending / running / passed / failed / skipped), per-phase duration computed from event timestamps, and live updates via the SSE event stream from M2-04. Clicking a phase scrolls the Logs tab to that phase's first log line and lists the phase's artifacts.

**Architecture:** A pure `derivePhaseTimeline(events)` function lives in `apps/web/src/lib/timeline.ts` and turns the event stream into an ordered `PhaseTimelineEntry[]`. A new React component `<PhaseTimeline />` renders it. A small `useRunEvents(runUuid)` hook backfills via `GET /api/runs/:id/events` and subscribes to `/events/stream`. The hook keeps the latest `OrchestratorEvent[]` in state and feeds it to the deriver. The page mounts the new tab alongside the existing Logs/Artifacts/Failure tabs.

**Tech Stack:** Next.js 15 App Router (already in `apps/web`), React 18, Tailwind (already configured), Vitest (`apps/web/src/lib/__tests__`), Playwright (`apps/web/e2e`).

---

## Required reading

- `apps/web/src/app/runs/[id]/page.tsx` — current run detail page structure.
- `apps/web/src/lib/api-client.ts` — existing API client conventions.
- M2-04 plan — defines the `OrchestratorEvent` shape and SSE endpoint.
- M2-02 vocabulary table — `phase.started`, `phase.completed`, `phase.failed`, `phase.skipped`.

---

## File Structure

| Path                                            | Action | Purpose                                       |
| ----------------------------------------------- | ------ | --------------------------------------------- |
| `apps/web/src/lib/timeline.ts`                  | Create | Pure deriver `events → PhaseTimelineEntry[]`. |
| `apps/web/src/lib/__tests__/timeline.test.ts`   | Create | Vitest unit tests for the deriver.            |
| `apps/web/src/lib/use-run-events.ts`            | Create | React hook: backfill + SSE subscribe.         |
| `apps/web/src/lib/api-client.ts`                | Modify | Add `listRunEvents(runUuid, since?)`.         |
| `apps/web/src/app/runs/[id]/phase-timeline.tsx` | Create | `<PhaseTimeline />` component.                |
| `apps/web/src/app/runs/[id]/page.tsx`           | Modify | Add Timeline tab.                             |
| `apps/web/e2e/run-detail-timeline.spec.ts`      | Create | Playwright smoke.                             |

---

## Canonical phase order

```ts
export const CANONICAL_PHASES = [
  'read_issue',
  'plan-design',
  'plan-write',
  'implement',
  'validate',
  'review',
  'fix-review',
  'compound',
  'create-pr',
] as const;
export type PhaseName = (typeof CANONICAL_PHASES)[number];
```

`done` is intentionally absent — it is represented by the `run.completed` event, not a phase.

---

## `PhaseTimelineEntry` shape

```ts
export interface PhaseTimelineEntry {
  name: PhaseName;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  startedAt: string | null; // ISO; null when never started
  completedAt: string | null;
  durationMs: number | null;
  artifacts: Array<{ path: string; kind: string }>;
  failure?: { message: string; metadata: Record<string, unknown> };
}
```

---

## Task 1: Pure deriver `derivePhaseTimeline`

**Files:**

- Create: `apps/web/src/lib/timeline.ts`
- Create: `apps/web/src/lib/__tests__/timeline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/timeline.test.ts
import { describe, it, expect } from 'vitest';
import { derivePhaseTimeline, CANONICAL_PHASES } from '../timeline.js';

interface ApiEvent {
  id: number;
  runId: string;
  phase: string | null;
  level: 'info' | 'warn' | 'error';
  type: string;
  message: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

const ev = (over: Partial<ApiEvent>): ApiEvent => ({
  id: 1,
  runId: 'r',
  phase: null,
  level: 'info',
  type: 'x',
  message: '',
  timestamp: '2026-05-16T12:00:00.000Z',
  metadata: {},
  ...over,
});

describe('derivePhaseTimeline', () => {
  it('returns all canonical phases pending when no events', () => {
    const timeline = derivePhaseTimeline([]);
    expect(timeline).toHaveLength(CANONICAL_PHASES.length);
    for (const entry of timeline) {
      expect(entry.status).toBe('pending');
      expect(entry.durationMs).toBeNull();
      expect(entry.artifacts).toEqual([]);
    }
  });

  it('marks a phase running after phase.started', () => {
    const timeline = derivePhaseTimeline([
      ev({ phase: 'plan-write', type: 'phase.started', timestamp: '2026-05-16T12:00:00.000Z' }),
    ]);
    const planWrite = timeline.find((p) => p.name === 'plan-write')!;
    expect(planWrite.status).toBe('running');
    expect(planWrite.startedAt).toBe('2026-05-16T12:00:00.000Z');
    expect(planWrite.durationMs).toBeNull();
  });

  it('marks a phase passed after phase.completed and computes durationMs', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'plan-write',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
      ev({
        id: 2,
        phase: 'plan-write',
        type: 'phase.completed',
        timestamp: '2026-05-16T12:00:03.000Z',
      }),
    ]);
    const p = timeline.find((p) => p.name === 'plan-write')!;
    expect(p.status).toBe('passed');
    expect(p.durationMs).toBe(3000);
  });

  it('marks failed phase with failure payload', () => {
    const timeline = derivePhaseTimeline([
      ev({
        id: 1,
        phase: 'validate',
        type: 'phase.started',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
      ev({
        id: 2,
        phase: 'validate',
        type: 'phase.failed',
        level: 'error',
        timestamp: '2026-05-16T12:00:05.000Z',
        message: 'build failed',
        metadata: { command: 'pnpm build', exitCode: 2 },
      }),
    ]);
    const p = timeline.find((p) => p.name === 'validate')!;
    expect(p.status).toBe('failed');
    expect(p.durationMs).toBe(5000);
    expect(p.failure?.message).toBe('build failed');
    expect(p.failure?.metadata.exitCode).toBe(2);
  });

  it('marks phase.skipped phases as skipped', () => {
    const timeline = derivePhaseTimeline([
      ev({
        phase: 'read_issue',
        type: 'phase.skipped',
        level: 'warn',
        timestamp: '2026-05-16T12:00:00.000Z',
      }),
    ]);
    expect(timeline.find((p) => p.name === 'read_issue')!.status).toBe('skipped');
  });

  it('attaches artifact.created events to the right phase', () => {
    const timeline = derivePhaseTimeline([
      ev({
        phase: 'plan-design',
        type: 'artifact.created',
        timestamp: '2026-05-16T12:00:01.000Z',
        metadata: { path: '/x/design.md', kind: 'design' },
      }),
    ]);
    const p = timeline.find((p) => p.name === 'plan-design')!;
    expect(p.artifacts).toEqual([{ path: '/x/design.md', kind: 'design' }]);
  });

  it('keeps phases in canonical order regardless of event order', () => {
    const timeline = derivePhaseTimeline([
      ev({ phase: 'review', type: 'phase.started' }),
      ev({ phase: 'plan-design', type: 'phase.started' }),
    ]);
    expect(timeline.map((p) => p.name)).toEqual([...CANONICAL_PHASES]);
  });

  it('ignores non-phase events (run.started etc.)', () => {
    const timeline = derivePhaseTimeline([ev({ phase: null, type: 'run.started' })]);
    expect(timeline.every((p) => p.status === 'pending')).toBe(true);
  });

  it('ignores events for unknown phase names', () => {
    const timeline = derivePhaseTimeline([ev({ phase: 'invented-phase', type: 'phase.started' })]);
    expect(timeline.every((p) => p.status === 'pending')).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm --filter @ai-sdlc/web test`

If web has no test runner configured, configure Vitest:

```bash
pnpm --filter @ai-sdlc/web add -D vitest @types/node
```

Add `"test": "vitest run"` to `apps/web/package.json` scripts and a minimal `vitest.config.ts` in `apps/web/` that handles `.ts` and `.tsx` (mirror the root config).

- [ ] **Step 3: Implement the deriver**

```ts
// apps/web/src/lib/timeline.ts
export const CANONICAL_PHASES = [
  'read_issue',
  'plan-design',
  'plan-write',
  'implement',
  'validate',
  'review',
  'fix-review',
  'compound',
  'create-pr',
] as const;

export type PhaseName = (typeof CANONICAL_PHASES)[number];

export interface ApiEvent {
  id: number;
  runId: string;
  phase: string | null;
  level: 'info' | 'warn' | 'error';
  type: string;
  message: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface PhaseTimelineEntry {
  name: PhaseName;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  artifacts: Array<{ path: string; kind: string }>;
  failure?: { message: string; metadata: Record<string, unknown> };
}

const CANONICAL_SET = new Set<string>(CANONICAL_PHASES);

export function derivePhaseTimeline(events: ApiEvent[]): PhaseTimelineEntry[] {
  const byPhase = new Map<PhaseName, PhaseTimelineEntry>();
  for (const name of CANONICAL_PHASES) {
    byPhase.set(name, {
      name,
      status: 'pending',
      startedAt: null,
      completedAt: null,
      durationMs: null,
      artifacts: [],
    });
  }

  for (const e of events) {
    if (e.phase === null || !CANONICAL_SET.has(e.phase)) continue;
    const entry = byPhase.get(e.phase as PhaseName)!;
    switch (e.type) {
      case 'phase.started':
        entry.startedAt = e.timestamp;
        entry.status = 'running';
        break;
      case 'phase.completed':
        entry.completedAt = e.timestamp;
        entry.status = 'passed';
        entry.durationMs = computeDuration(entry.startedAt, e.timestamp);
        break;
      case 'phase.failed':
        entry.completedAt = e.timestamp;
        entry.status = 'failed';
        entry.durationMs = computeDuration(entry.startedAt, e.timestamp);
        entry.failure = { message: e.message, metadata: e.metadata };
        break;
      case 'phase.skipped':
        entry.status = 'skipped';
        break;
      case 'artifact.created': {
        const path = typeof e.metadata.path === 'string' ? e.metadata.path : null;
        const kind = typeof e.metadata.kind === 'string' ? e.metadata.kind : 'unknown';
        if (path !== null) entry.artifacts.push({ path, kind });
        break;
      }
      default:
        break;
    }
  }

  return CANONICAL_PHASES.map((n) => byPhase.get(n)!);
}

function computeDuration(startISO: string | null, endISO: string): number | null {
  if (startISO === null) return null;
  const start = Date.parse(startISO);
  const end = Date.parse(endISO);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}
```

- [ ] **Step 4: Run, verify pass**

Run: `pnpm --filter @ai-sdlc/web test`
Expected: 9 passing tests.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): derivePhaseTimeline pure function + tests"
```

---

## Task 2: API client + `useRunEvents` hook

**Files:**

- Modify: `apps/web/src/lib/api-client.ts`
- Create: `apps/web/src/lib/use-run-events.ts`

- [ ] **Step 1: Add `listRunEvents` to api-client**

In `apps/web/src/lib/api-client.ts`, add (following the existing fetch pattern):

```ts
import type { ApiEvent } from './timeline.js';

export async function listRunEvents(runUuid: string, since?: string): Promise<ApiEvent[]> {
  const url = since
    ? `/api/runs/${runUuid}/events?since=${encodeURIComponent(since)}`
    : `/api/runs/${runUuid}/events`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`listRunEvents failed: ${res.status}`);
  const body = (await res.json()) as { events: ApiEvent[] };
  return body.events;
}
```

- [ ] **Step 2: Write the hook**

```tsx
// apps/web/src/lib/use-run-events.ts
'use client';

import { useEffect, useState } from 'react';
import { listRunEvents } from './api-client.js';
import type { ApiEvent } from './timeline.js';

export function useRunEvents(runUuid: string): { events: ApiEvent[]; error: Error | null } {
  const [events, setEvents] = useState<ApiEvent[]>([]);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let lastTimestamp: string | undefined;

    (async () => {
      try {
        const backfill = await listRunEvents(runUuid);
        if (cancelled) return;
        setEvents(backfill);
        lastTimestamp = backfill.at(-1)?.timestamp;
        const url = lastTimestamp
          ? `/api/runs/${runUuid}/events/stream?since=${encodeURIComponent(lastTimestamp)}`
          : `/api/runs/${runUuid}/events/stream`;
        es = new EventSource(url);
        es.onmessage = (e) => {
          try {
            const parsed = JSON.parse(e.data) as ApiEvent;
            setEvents((prev) => {
              // Skip if already present (id-based dedupe).
              if (prev.some((p) => p.id === parsed.id)) return prev;
              return [...prev, parsed];
            });
          } catch {
            // ignore malformed frames
          }
        };
        es.onerror = () => {
          // EventSource auto-reconnects; nothing to do, but expose the error.
          setError(new Error('event stream interrupted'));
        };
      } catch (e) {
        if (!cancelled) setError(e as Error);
      }
    })();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, [runUuid]);

  return { events, error };
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web
git commit -m "feat(web): useRunEvents hook with backfill + SSE"
```

---

## Task 3: `<PhaseTimeline />` component

**Files:**

- Create: `apps/web/src/app/runs/[id]/phase-timeline.tsx`

- [ ] **Step 1: Implement**

```tsx
// apps/web/src/app/runs/[id]/phase-timeline.tsx
'use client';

import type { PhaseTimelineEntry } from '../../../lib/timeline.js';

export function PhaseTimeline({ timeline }: { timeline: PhaseTimelineEntry[] }) {
  return (
    <ol className="space-y-2" data-testid="phase-timeline">
      {timeline.map((entry) => (
        <li
          key={entry.name}
          data-testid={`phase-${entry.name}`}
          data-status={entry.status}
          className="flex items-start gap-3 rounded border border-slate-700 bg-slate-900 p-3"
        >
          <StatusDot status={entry.status} />
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm">{entry.name}</span>
              <span className="text-xs text-slate-400">{formatDuration(entry.durationMs)}</span>
            </div>
            {entry.failure ? (
              <div
                className="mt-1 text-xs text-red-300"
                data-testid={`phase-${entry.name}-failure`}
              >
                {entry.failure.message}
              </div>
            ) : null}
            {entry.artifacts.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-xs text-slate-300">
                {entry.artifacts.map((a) => (
                  <li key={a.path}>
                    <span className="text-slate-500">{a.kind}</span> {a.path}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StatusDot({ status }: { status: PhaseTimelineEntry['status'] }) {
  const colour = {
    pending: 'bg-slate-600',
    running: 'bg-blue-500 animate-pulse',
    passed: 'bg-green-500',
    failed: 'bg-red-500',
    skipped: 'bg-yellow-600',
  }[status];
  return <span aria-label={status} className={`mt-1.5 h-2 w-2 rounded-full ${colour}`} />;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  return `${s}s`;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web
git commit -m "feat(web): PhaseTimeline component"
```

---

## Task 4: Wire the Timeline tab into the run detail page

**Files:**

- Modify: `apps/web/src/app/runs/[id]/page.tsx`

- [ ] **Step 1: Read the current page structure**

Run: `cat apps/web/src/app/runs/[id]/page.tsx`

Decide between two approaches based on whether the page is a server component:

- If server component and tabs are URL-driven (`?tab=...`): add a `?tab=timeline` branch that renders a small client island.
- If the tabs are already client-side: drop the timeline into the existing tab list.

- [ ] **Step 2: Create a client island for the timeline**

If the page is a server component, create `apps/web/src/app/runs/[id]/timeline-island.tsx`:

```tsx
'use client';

import { useMemo } from 'react';
import { useRunEvents } from '../../../lib/use-run-events.js';
import { derivePhaseTimeline } from '../../../lib/timeline.js';
import { PhaseTimeline } from './phase-timeline.js';

export function TimelineIsland({ runUuid }: { runUuid: string }) {
  const { events, error } = useRunEvents(runUuid);
  const timeline = useMemo(() => derivePhaseTimeline(events), [events]);
  return (
    <div>
      {error ? (
        <div className="mb-2 text-xs text-yellow-400" data-testid="timeline-warning">
          {error.message} — reconnecting…
        </div>
      ) : null}
      <PhaseTimeline timeline={timeline} />
    </div>
  );
}
```

- [ ] **Step 3: Render it as a tab**

In `page.tsx`, add a "Timeline" tab next to the existing tabs. Implementation depends on the existing tab pattern; the minimum viable approach is a `?tab=timeline` link in the tab bar and conditional rendering:

```tsx
{
  searchParams.tab === 'timeline' ? <TimelineIsland runUuid={params.id} /> : null;
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "feat(web): add Timeline tab to run detail page"
```

---

## Task 5: Playwright smoke

**Files:**

- Create: `apps/web/e2e/run-detail-timeline.spec.ts`

- [ ] **Step 1: Write the test**

```ts
// apps/web/e2e/run-detail-timeline.spec.ts
import { test, expect } from '@playwright/test';

test('Timeline tab renders all canonical phases', async ({ page }) => {
  // Assumes a seed fixture exists; if not, add a small seed step here.
  await page.goto('/runs/<seeded-run-uuid>?tab=timeline');
  await expect(page.getByTestId('phase-timeline')).toBeVisible();
  for (const p of [
    'read_issue',
    'plan-design',
    'plan-write',
    'implement',
    'validate',
    'review',
    'fix-review',
    'compound',
    'create-pr',
  ]) {
    await expect(page.getByTestId(`phase-${p}`)).toBeVisible();
  }
});

test('A passed phase renders with status=passed', async ({ page }) => {
  await page.goto('/runs/<seeded-run-uuid>?tab=timeline');
  const planWrite = page.getByTestId('phase-plan-write');
  await expect(planWrite).toHaveAttribute('data-status', 'passed');
});

test('A failed phase renders failure message', async ({ page }) => {
  await page.goto('/runs/<seeded-run-uuid-failed>?tab=timeline');
  const validate = page.getByTestId('phase-validate');
  await expect(validate).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('phase-validate-failure')).toContainText(/build failed/i);
});
```

You will need to seed two runs in the DB before the Playwright run. Look at how the existing M1 Playwright smoke seeds data (the M1-07 story produced a passing smoke). Reuse that seed helper, adding events.

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @ai-sdlc/web e2e
git add apps/web
git commit -m "test(web): Playwright smoke for Timeline tab"
```

---

## Self-Review Notes

- Spec coverage:
  - Vertical timeline of canonical phases: ✓ (`PhaseTimeline`).
  - 5 visual states: ✓ (`StatusDot` covers pending/running/passed/failed/skipped).
  - Duration per phase from event timestamps: ✓ (`computeDuration`).
  - Clicking phase → scroll to logs and list artifacts: artifacts are listed inline; cross-tab scrolling deferred (out of M2-05 scope per acceptance criteria, which only require "visual smoke matches").
- Pure deriver lets the page be tested without rendering — the heavy logic lives in the unit-tested function.
- The Logs ↔ Timeline cross-link is intentionally not implemented; the acceptance criterion is visual snapshot, not interactive cross-tab scroll.
