# M2-04: Ingest Events into SQLite + SSE Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While the wrapped Bash child runs, tail its `events.jsonl`, validate each line against a shared Zod schema, insert it into the SQLite `events` table, and expose two REST endpoints: a polling endpoint `GET /api/runs/:runId/events?since=...` and an SSE endpoint `GET /api/runs/:runId/events/stream` that backfills from `since` then streams new rows. Reconnect with `?since=` must be idempotent (no duplicates).

**Architecture:**

- A new `EventSchema` (Zod) lives in `packages/shared/src/events/schema.ts` and is the single source of truth.
- A new `EventTailer` (in `packages/infrastructure/src/events/tailer.ts`) wraps a `chokidar`-style tail or simpler `fs.watch` + offset cursor: it reads new bytes appended to `events.jsonl`, parses lines, validates, and pushes events to a callback. Invalid lines are logged and skipped.
- `StartIssueRun` starts the tailer before spawning the bash script and stops it after the child exits + final flush.
- Each event passes through `EventRepository.insert(...)` (already exists, M1-04) and also through a process-local `EventBus` (in-process EventEmitter keyed by `runUuid`) so SSE subscribers receive live events without polling the DB.
- The SSE endpoint subscribes to the EventBus AND backfills from the DB since the cursor.
- Cursor: ISO timestamp + `id` for tiebreak. `since` is ISO; the API returns events where `(timestamp > since) OR (timestamp == since AND id > sinceId)`. Simpler MVP: use just `id` ordered by `(timestamp, id)` and let `since` be the last-seen `id`.

**Tech Stack:** Node 22, TypeScript strict, Fastify (already in `apps/api`), better-sqlite3, Zod, Vitest.

---

## Required reading

- `packages/infrastructure/src/sqlite/event-repository.ts` — existing repo.
- `packages/infrastructure/src/sqlite/migrations/0001-init.ts` — `events` schema already there.
- `apps/api/src/compose.ts` — composition root.
- `apps/api/src/routes/runs.ts` — existing routes file pattern.
- M2-01 emit_event spec — defines the JSON shape we must validate.

---

## File Structure

| Path                                                          | Action | Purpose                                            |
| ------------------------------------------------------------- | ------ | -------------------------------------------------- |
| `packages/shared/src/events/schema.ts`                        | Create | Zod schema + TS type for one event.                |
| `packages/shared/src/index.ts`                                | Modify | Export the new module.                             |
| `packages/shared/src/events/__tests__/schema.test.ts`         | Create | Schema unit tests.                                 |
| `packages/infrastructure/src/events/tailer.ts`                | Create | File tailer that emits parsed events.              |
| `packages/infrastructure/src/events/event-bus.ts`             | Create | Per-runUuid in-process pub/sub.                    |
| `packages/infrastructure/src/events/__tests__/tailer.test.ts` | Create | Tailer integration test against tmp files.         |
| `packages/infrastructure/src/index.ts`                        | Modify | Re-export `EventTailer`, `InMemoryEventBus`.       |
| `packages/application/src/start-issue-run.ts` (or equivalent) | Modify | Wire tailer + bus into use case.                   |
| `apps/api/src/compose.ts`                                     | Modify | Build the EventBus, hand it to use cases + routes. |
| `apps/api/src/routes/events.ts`                               | Create | `GET /api/runs/:runId/events` and `/stream`.       |
| `apps/api/src/server.ts`                                      | Modify | Register `eventsRoutes`.                           |
| `apps/api/src/__tests__/events-api.test.ts`                   | Create | API integration tests (polling + SSE).             |

---

## Task 1: Shared Zod event schema

**Files:**

- Create: `packages/shared/src/events/schema.ts`
- Create: `packages/shared/src/events/__tests__/schema.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

`packages/shared/src/events/__tests__/schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { eventSchema, type OrchestratorEvent } from '../schema.js';

describe('eventSchema', () => {
  const minimal = {
    runId: 'issue-1-20260516-120000',
    level: 'info' as const,
    type: 'run.started',
    message: 'hi',
    timestamp: '2026-05-16T12:00:00.000Z',
    metadata: {},
  };

  it('accepts a minimal run-level event (no phase)', () => {
    const parsed = eventSchema.parse(minimal);
    expect(parsed.runId).toBe('issue-1-20260516-120000');
    expect(parsed.phase).toBeUndefined();
  });

  it('accepts a phase-level event', () => {
    const parsed = eventSchema.parse({ ...minimal, phase: 'plan-write', type: 'phase.started' });
    expect(parsed.phase).toBe('plan-write');
  });

  it('rejects unknown levels', () => {
    expect(() => eventSchema.parse({ ...minimal, level: 'fatal' })).toThrow();
  });

  it('rejects empty type and empty runId', () => {
    expect(() => eventSchema.parse({ ...minimal, type: '' })).toThrow();
    expect(() => eventSchema.parse({ ...minimal, runId: '' })).toThrow();
  });

  it('rejects non-ISO timestamps', () => {
    expect(() => eventSchema.parse({ ...minimal, timestamp: 'last tuesday' })).toThrow();
  });

  it('defaults metadata to {}', () => {
    const { metadata: _m, ...withoutMeta } = minimal;
    const parsed = eventSchema.parse(withoutMeta);
    expect(parsed.metadata).toEqual({});
  });

  it('preserves arbitrary metadata values (numbers, booleans, strings)', () => {
    const parsed = eventSchema.parse({
      ...minimal,
      metadata: { exitCode: 2, ok: true, command: 'pnpm build' },
    });
    expect(parsed.metadata).toEqual({ exitCode: 2, ok: true, command: 'pnpm build' });
  });

  it('type-narrows OrchestratorEvent to required fields', () => {
    const ev: OrchestratorEvent = minimal;
    expect(ev.message).toBe('hi');
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm --filter @ai-sdlc/shared test`
Expected: FAIL — schema doesn't exist.

- [ ] **Step 3: Implement the schema**

`packages/shared/src/events/schema.ts`:

```ts
import { z } from 'zod';

const isoTimestamp = z
  .string()
  .min(1)
  .refine((s) => !Number.isNaN(Date.parse(s)), {
    message: 'must be a parseable ISO 8601 timestamp',
  });

export const eventSchema = z.object({
  runId: z.string().min(1),
  phase: z.string().min(1).optional(),
  level: z.enum(['info', 'warn', 'error']),
  type: z.string().min(1),
  message: z.string(),
  timestamp: isoTimestamp,
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type OrchestratorEvent = z.infer<typeof eventSchema>;
```

- [ ] **Step 4: Export it**

Edit `packages/shared/src/index.ts` to add:

```ts
export * from './events/schema.js';
```

- [ ] **Step 5: Run + verify pass**

Run: `pnpm --filter @ai-sdlc/shared test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add OrchestratorEvent Zod schema"
```

---

## Task 2: In-process `EventBus`

**Files:**

- Create: `packages/infrastructure/src/events/event-bus.ts`
- Create: `packages/infrastructure/src/events/__tests__/event-bus.test.ts`
- Modify: `packages/infrastructure/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/infrastructure/src/events/__tests__/event-bus.test.ts
import { describe, it, expect } from 'vitest';
import { InMemoryEventBus } from '../event-bus.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

const ev = (runId: string, type: string): OrchestratorEvent => ({
  runId,
  level: 'info',
  type,
  message: type,
  timestamp: new Date().toISOString(),
  metadata: {},
});

describe('InMemoryEventBus', () => {
  it('delivers events to subscribers of the same runUuid', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    const unsub = bus.subscribe('uuid-a', (e) => seen.push(e.type));
    bus.publish('uuid-a', ev('display-a', 'phase.started'));
    bus.publish('uuid-a', ev('display-a', 'phase.completed'));
    expect(seen).toEqual(['phase.started', 'phase.completed']);
    unsub();
  });

  it('isolates events by runUuid', () => {
    const bus = new InMemoryEventBus();
    const seenA: string[] = [];
    const seenB: string[] = [];
    bus.subscribe('uuid-a', (e) => seenA.push(e.type));
    bus.subscribe('uuid-b', (e) => seenB.push(e.type));
    bus.publish('uuid-a', ev('a', 't1'));
    bus.publish('uuid-b', ev('b', 't2'));
    expect(seenA).toEqual(['t1']);
    expect(seenB).toEqual(['t2']);
  });

  it('unsubscribe stops delivery', () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    const unsub = bus.subscribe('u', (e) => seen.push(e.type));
    bus.publish('u', ev('d', 't1'));
    unsub();
    bus.publish('u', ev('d', 't2'));
    expect(seen).toEqual(['t1']);
  });
});
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm --filter @ai-sdlc/infrastructure test`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// packages/infrastructure/src/events/event-bus.ts
import { EventEmitter } from 'node:events';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

export type EventListener = (event: OrchestratorEvent) => void;
export type Unsubscribe = () => void;

export class InMemoryEventBus {
  private readonly emitters = new Map<string, EventEmitter>();

  subscribe(runUuid: string, listener: EventListener): Unsubscribe {
    let emitter = this.emitters.get(runUuid);
    if (!emitter) {
      emitter = new EventEmitter();
      // Allow many SSE clients per run without warning.
      emitter.setMaxListeners(0);
      this.emitters.set(runUuid, emitter);
    }
    emitter.on('event', listener);
    return () => {
      emitter?.off('event', listener);
      if (emitter && emitter.listenerCount('event') === 0) {
        this.emitters.delete(runUuid);
      }
    };
  }

  publish(runUuid: string, event: OrchestratorEvent): void {
    const emitter = this.emitters.get(runUuid);
    if (emitter) emitter.emit('event', event);
  }
}
```

- [ ] **Step 4: Re-export from infrastructure index**

Edit `packages/infrastructure/src/index.ts`:

```ts
export * from './events/event-bus.js';
export * from './events/tailer.js'; // pre-export; created in Task 3
```

(If `tailer.js` doesn't exist yet, comment out that line until Task 3 finishes — or do Tasks 2 and 3 back-to-back before re-running build.)

- [ ] **Step 5: Run + verify**

Run: `pnpm --filter @ai-sdlc/infrastructure test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/infrastructure
git commit -m "feat(infra): in-memory EventBus keyed by runUuid"
```

---

## Task 3: `EventTailer`

**Files:**

- Create: `packages/infrastructure/src/events/tailer.ts`
- Create: `packages/infrastructure/src/events/__tests__/tailer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/infrastructure/src/events/__tests__/tailer.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventTailer } from '../tailer.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

function ev(type: string, t = '2026-05-16T12:00:00.000Z'): string {
  return JSON.stringify({
    runId: 'r1',
    level: 'info',
    type,
    message: type,
    timestamp: t,
    metadata: {},
  });
}

describe('EventTailer', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tailer-'));
    path = join(dir, 'events.jsonl');
    writeFileSync(path, '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('emits one event per appended line', async () => {
    const seen: OrchestratorEvent[] = [];
    const tailer = new EventTailer({ path, onEvent: (e) => seen.push(e), pollIntervalMs: 20 });
    await tailer.start();
    appendFileSync(path, ev('a') + '\n');
    appendFileSync(path, ev('b') + '\n');
    await waitUntil(() => seen.length === 2, 1000);
    expect(seen.map((e) => e.type)).toEqual(['a', 'b']);
    await tailer.stop();
  });

  it('skips malformed lines but reports them via onParseError', async () => {
    const seen: OrchestratorEvent[] = [];
    const errors: Error[] = [];
    const tailer = new EventTailer({
      path,
      onEvent: (e) => seen.push(e),
      onParseError: (err) => errors.push(err),
      pollIntervalMs: 20,
    });
    await tailer.start();
    appendFileSync(path, ev('a') + '\n');
    appendFileSync(path, 'this-is-not-json\n');
    appendFileSync(path, ev('b') + '\n');
    await waitUntil(() => seen.length === 2 && errors.length === 1, 1000);
    expect(seen.map((e) => e.type)).toEqual(['a', 'b']);
    await tailer.stop();
  });

  it('drainAndStop processes residual bytes before resolving', async () => {
    const seen: OrchestratorEvent[] = [];
    const tailer = new EventTailer({ path, onEvent: (e) => seen.push(e), pollIntervalMs: 1000 });
    await tailer.start();
    appendFileSync(path, ev('a') + '\n');
    appendFileSync(path, ev('b') + '\n');
    await tailer.drainAndStop();
    expect(seen.map((e) => e.type)).toEqual(['a', 'b']);
  });
});

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  // Polls every 10ms.
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
```

- [ ] **Step 2: Run, verify failure**

Run: `pnpm --filter @ai-sdlc/infrastructure test`
Expected: FAIL.

- [ ] **Step 3: Implement the tailer**

```ts
// packages/infrastructure/src/events/tailer.ts
import { promises as fs } from 'node:fs';
import { eventSchema, type OrchestratorEvent } from '@ai-sdlc/shared';

export interface EventTailerOptions {
  path: string;
  onEvent: (event: OrchestratorEvent) => void;
  onParseError?: (err: Error, line: string) => void;
  /** How often to poll for new bytes when no fs watch fires. Default 100ms. */
  pollIntervalMs?: number;
}

export class EventTailer {
  private readonly path: string;
  private readonly onEvent: (e: OrchestratorEvent) => void;
  private readonly onParseError?: (err: Error, line: string) => void;
  private readonly pollIntervalMs: number;
  private offset = 0;
  private buffer = '';
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(opts: EventTailerOptions) {
    this.path = opts.path;
    this.onEvent = opts.onEvent;
    if (opts.onParseError !== undefined) this.onParseError = opts.onParseError;
    this.pollIntervalMs = opts.pollIntervalMs ?? 100;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.tick();
    this.scheduleTick();
  }

  private scheduleTick(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick().finally(() => this.scheduleTick());
    }, this.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (stat.size < this.offset) {
      // File truncated or rotated — reset.
      this.offset = 0;
      this.buffer = '';
    }
    if (stat.size === this.offset) return;
    const fh = await fs.open(this.path, 'r');
    try {
      const len = stat.size - this.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, this.offset);
      this.offset = stat.size;
      this.buffer += buf.toString('utf8');
      this.flushLines();
    } finally {
      await fh.close();
    }
  }

  private flushLines(): void {
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        this.onParseError?.(err as Error, line);
        continue;
      }
      const result = eventSchema.safeParse(parsed);
      if (!result.success) {
        this.onParseError?.(new Error(result.error.message), line);
        continue;
      }
      this.onEvent(result.data);
    }
  }

  async drainAndStop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
```

- [ ] **Step 4: Run + verify pass**

Run: `pnpm --filter @ai-sdlc/infrastructure test`
Expected: PASS (including all three tailer tests).

- [ ] **Step 5: Commit**

```bash
git add packages/infrastructure
git commit -m "feat(infra): EventTailer for events.jsonl"
```

---

## Task 4: Wire tailer + bus into `StartIssueRun`

**Files:**

- Modify: `packages/application/src/<start-issue-run>.ts` (locate via `grep -rln "class StartIssueRun" packages/application/src`)
- Modify: `apps/api/src/compose.ts`

- [ ] **Step 1: Find the use case**

Run: `grep -rln "class StartIssueRun" packages/application/src`

Note its constructor `StartIssueRunDeps` shape.

- [ ] **Step 2: Add deps**

Extend `StartIssueRunDeps`:

```ts
export interface StartIssueRunDeps {
  // ...existing
  eventRepository: EventRepository;
  eventBus: InMemoryEventBus;
  createEventTailer: (input: {
    path: string;
    onEvent: (e: OrchestratorEvent) => void;
    onParseError: (err: Error, line: string) => void;
  }) => EventTailer;
}
```

`EventRepository` is already imported in compose; add it to the deps interface.

- [ ] **Step 3: Use the tailer around the bash run**

Inside the use-case `execute` method, wrap the existing `runBashScript` call:

```ts
const onEvent = (e: OrchestratorEvent): void => {
  this.deps.eventRepository.insert({
    runUuid: run.uuid,
    phase: e.phase,
    level: e.level,
    type: e.type,
    message: e.message,
    metadata: e.metadata,
    timestamp: new Date(e.timestamp),
  });
  this.deps.eventBus.publish(run.uuid, e);
};
const tailer = this.deps.createEventTailer({
  path: runDirectory.paths.eventsJsonlPath,
  onEvent,
  onParseError: (err, line) => {
    // Best-effort: log and continue.
    console.warn(`Invalid event line for run ${run.displayId}: ${err.message}`, line);
  },
});
await tailer.start();
try {
  const result = await this.deps.runBashScript({
    /* existing */
  });
  // existing post-run logic
  return result;
} finally {
  await tailer.drainAndStop();
}
```

- [ ] **Step 4: Update `composeRoot` to inject the new deps**

In `apps/api/src/compose.ts`:

```ts
import { InMemoryEventBus, EventTailer } from '@ai-sdlc/infrastructure';

// inside composeRoot:
const eventBus = new InMemoryEventBus();

const deps: StartIssueRunDeps = {
  // ...existing fields
  eventRepository,
  eventBus,
  createEventTailer: (input) => new EventTailer(input),
};
```

Add `eventBus` to the returned `Container`.

- [ ] **Step 5: Write a use-case test**

In the existing `StartIssueRun` test file, add:

```ts
it('inserts events from events.jsonl into the EventRepository as the script runs', async () => {
  const inserted: Array<{ type: string; phase?: string }> = [];
  const fakeRepo = {
    insert: (e: { type: string; phase?: string }) => {
      inserted.push(e);
      return 1;
    },
  } as unknown as EventRepository;
  // Use a fake tailer that calls onEvent for two events synchronously.
  const fakeTailer = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    drainAndStop: vi.fn(async () => {}),
  };
  // pass createEventTailer that captures onEvent and feeds events
  // (see existing test helpers for shape)
  // ...
});
```

Adapt to whatever the existing test fixture helpers provide.

- [ ] **Step 6: Run + commit**

```bash
pnpm --filter @ai-sdlc/application test
pnpm --filter @ai-sdlc/api test
git add packages/application apps/api
git commit -m "feat(app): tail events.jsonl into SQLite + EventBus during bash run"
```

---

## Task 5: Polling endpoint `GET /api/runs/:runId/events`

**Files:**

- Create: `apps/api/src/routes/events.ts`
- Modify: `apps/api/src/server.ts` (register the routes)
- Create: `apps/api/src/__tests__/events-api.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/__tests__/events-api.test.ts
import { describe, it, expect } from 'vitest';
import { buildTestApp } from './test-helpers.js'; // assume one exists or write a small helper

describe('GET /api/runs/:runId/events', () => {
  it('returns 404 for unknown run', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs/00000000-0000-0000-0000-000000000000/events',
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns events for a run, ordered by (timestamp, id)', async () => {
    const { app, seed } = await buildTestApp();
    const { uuid } = seed.run();
    seed.event(uuid, { type: 'a', timestamp: '2026-05-16T12:00:00.000Z' });
    seed.event(uuid, { type: 'b', timestamp: '2026-05-16T12:00:01.000Z' });
    const res = await app.inject({ method: 'GET', url: `/api/runs/${uuid}/events` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<{ type: string }> };
    expect(body.events.map((e) => e.type)).toEqual(['a', 'b']);
  });

  it('filters with ?since=ISO using a strict-greater comparison', async () => {
    const { app, seed } = await buildTestApp();
    const { uuid } = seed.run();
    seed.event(uuid, { type: 'a', timestamp: '2026-05-16T12:00:00.000Z' });
    seed.event(uuid, { type: 'b', timestamp: '2026-05-16T12:00:01.000Z' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/${uuid}/events?since=2026-05-16T12:00:00.000Z`,
    });
    const body = res.json() as { events: Array<{ type: string }> };
    expect(body.events.map((e) => e.type)).toEqual(['b']);
  });

  it('returns 400 on invalid since cursor', async () => {
    const { app, seed } = await buildTestApp();
    const { uuid } = seed.run();
    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/${uuid}/events?since=garbage`,
    });
    expect(res.statusCode).toBe(400);
  });
});
```

If `buildTestApp` doesn't exist, write a minimal version that builds a Fastify app with a `:memory:` SQLite using the same `composeRoot` factory pattern (see existing api tests for the pattern).

- [ ] **Step 2: Run, verify failure**

Run: `pnpm --filter @ai-sdlc/api test`
Expected: 4 failing tests (route not registered).

- [ ] **Step 3: Implement the route**

```ts
// apps/api/src/routes/events.ts
import type { FastifyInstance } from 'fastify';
import type { Container } from '../compose.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function eventsRoutes(app: FastifyInstance, c: Container): Promise<void> {
  app.get<{ Params: { runId: string }; Querystring: { since?: string } }>(
    '/api/runs/:runId/events',
    async (req, reply) => {
      if (!UUID_RE.test(req.params.runId)) return reply.code(400).send({ error: 'invalid_id' });
      const run = c.runRepository.findByUuid(req.params.runId);
      if (!run) return reply.code(404).send({ error: 'not_found' });
      let events;
      try {
        events = c.eventRepository.listByRunSince(req.params.runId, req.query.since);
      } catch (e) {
        return reply.code(400).send({ error: 'invalid_since', message: (e as Error).message });
      }
      return {
        events: events.map((e) => ({
          id: e.id,
          runId: run.displayId,
          phase: e.phase ?? null,
          level: e.level,
          type: e.type,
          message: e.message,
          timestamp: e.timestamp.toISOString(),
          metadata: e.metadata,
        })),
      };
    },
  );
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/server.ts`, add:

```ts
import { eventsRoutes } from './routes/events.js';
// inside the function that registers routes:
await eventsRoutes(app, container);
```

- [ ] **Step 5: Run + commit**

```bash
pnpm --filter @ai-sdlc/api test
git add apps/api
git commit -m "feat(api): GET /api/runs/:runId/events"
```

---

## Task 6: SSE endpoint `GET /api/runs/:runId/events/stream`

**Files:**

- Modify: `apps/api/src/routes/events.ts`
- Modify: `apps/api/src/__tests__/events-api.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `events-api.test.ts`:

```ts
describe('GET /api/runs/:runId/events/stream', () => {
  it('streams new events live, backfilling from ?since=', async () => {
    const { app, seed, eventBus } = await buildTestApp();
    const { uuid, displayId } = seed.run();
    seed.event(uuid, { type: 'pre', timestamp: '2026-05-16T12:00:00.000Z' });

    const responsePromise = app.inject({
      method: 'GET',
      url: `/api/runs/${uuid}/events/stream`,
      headers: { accept: 'text/event-stream' },
      payloadAsStream: true,
    });

    // ...read first SSE chunks, expect 'pre' from backfill, then publish a live event
    // and expect it to arrive.
    // See Fastify inject docs for SSE; if it's hard, simulate by directly reading
    // the response stream with a 200ms timeout.
  });

  it('does not duplicate when client reconnects with ?since=<last>', async () => {
    // seed events, open stream, read first event, close, reopen with since=that timestamp,
    // verify only newer events arrive.
  });
});
```

(These tests are intentionally sketched — Fastify `inject` does not fully support SSE streaming. If `inject` proves awkward, start the server on an ephemeral port via `app.listen({ port: 0 })` and use Node's `http.get` to read chunks directly.)

- [ ] **Step 2: Implement the SSE handler**

In `apps/api/src/routes/events.ts`, add:

```ts
app.get<{ Params: { runId: string }; Querystring: { since?: string } }>(
  '/api/runs/:runId/events/stream',
  async (req, reply) => {
    if (!UUID_RE.test(req.params.runId)) return reply.code(400).send({ error: 'invalid_id' });
    const run = c.runRepository.findByUuid(req.params.runId);
    if (!run) return reply.code(404).send({ error: 'not_found' });

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    const send = (id: number | string, event: unknown): void => {
      reply.raw.write(`id: ${id}\n`);
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Backfill.
    let lastTimestamp: string | undefined;
    try {
      const backfill = c.eventRepository.listByRunSince(req.params.runId, req.query.since);
      for (const e of backfill) {
        const payload = {
          id: e.id,
          runId: run.displayId,
          phase: e.phase ?? null,
          level: e.level,
          type: e.type,
          message: e.message,
          timestamp: e.timestamp.toISOString(),
          metadata: e.metadata,
        };
        send(e.id, payload);
        lastTimestamp = e.timestamp.toISOString();
      }
    } catch (e) {
      reply.raw.end();
      return;
    }

    // Live.
    const unsub = c.eventBus.subscribe(req.params.runId, (e) => {
      // Skip events whose timestamp is <= what we already backfilled (avoid duplicates).
      if (lastTimestamp !== undefined && e.timestamp <= lastTimestamp) return;
      send(e.timestamp, e);
    });

    // Heartbeat every 15s to keep proxies honest.
    const heartbeat = setInterval(() => reply.raw.write(': hb\n\n'), 15_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsub();
    });

    // Return nothing — keep the response open.
    return reply;
  },
);
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @ai-sdlc/api test
git add apps/api
git commit -m "feat(api): SSE event stream for runs with backfill and live publish"
```

---

## Task 7: End-to-end smoke test

**Files:**

- Modify: `apps/api/src/__tests__/wrapper-e2e.test.ts` (or wherever the M1 e2e test lives — search `grep -rln "fake-script\|stub script" apps/api/src/__tests__`).

- [ ] **Step 1: Add an assertion**

After running the wrapped fake script that emits events, assert:

```ts
const events = container.eventRepository.listByRunSince(run.uuid);
expect(events.length).toBeGreaterThan(0);
expect(events.find((e) => e.type === 'run.started')).toBeDefined();
expect(events.find((e) => e.type === 'run.completed')).toBeDefined();
```

The fake script must `source scripts/lib/emit_event.sh` and emit a few events (see M2-01 Task 4 / M2-02 Task 10 for the shape).

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @ai-sdlc/api test
git add apps/api
git commit -m "test(api): assert events.jsonl is ingested into SQLite during wrapped run"
```

---

## Self-Review Notes

- Spec coverage:
  - Tail + persist to SQLite: Tasks 3, 4.
  - SSE with backfill + reconnection: Task 6 (no duplicates because the `since` cursor is honored on reconnect; the live publish skips events <= last backfill timestamp).
  - Polling endpoint: Task 5.
  - Latency target (≤500ms): tailer polls at 100ms; happy-case worst case ≈100ms + insert time.
- Type consistency: `OrchestratorEvent.timestamp` is `string` (ISO); `EventRow.timestamp` is `Date`. The route converts to ISO before sending; the use case converts ISO → `Date` before inserting.
- Reconnection without duplicates: the SSE handler tracks `lastTimestamp` from backfill and the live publisher's deduplication check uses strict `>`; combined with the polling endpoint's strict-greater `since` comparison, a client can safely reconnect with the timestamp of the last event it received.
- Out of scope for M2-04: per-event `id` cursors (a stricter total ordering) — the timestamp+order-of-insert approach is sufficient for MVP. A future story can switch to `(timestamp, id)` cursors if needed.
