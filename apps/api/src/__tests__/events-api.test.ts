import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot, type Container } from '../compose.js';
import { startServer } from '../server.js';
import { createRun, RepositoryId } from '@ai-sdlc/domain';
import { newRunId } from '@ai-sdlc/shared';

function insertTestRun(
  container: Container,
  issueNumber = 99,
  repoId = RepositoryId('owner/repo'),
) {
  const startedAt = new Date();
  const ids = newRunId({ issueNumber, now: startedAt });
  const run = createRun({
    uuid: ids.uuid,
    displayId: ids.displayId,
    repoId,
    issueNumber,
    startedAt,
  });
  container.runRepository.insertIfNoActive(run);
  return { uuid: ids.uuid, displayId: ids.displayId, run };
}

async function bootServer(opts?: { scriptPath?: string }): Promise<{
  baseUrl: string;
  container: Container;
  stop: () => Promise<void>;
  port: number;
}> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ai-orch-events-'));
  tempDirs.push(repoRoot);
  const scriptPath = opts?.scriptPath ?? join(repoRoot, 'fake.sh');
  if (!opts?.scriptPath) {
    writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\nexit 0\n');
    chmodSync(scriptPath, 0o755);
  }
  const container = composeRoot({ repoRoot, scriptPath, repoFullName: 'owner/repo' });
  const server = await startServer({ container, port: 0, forceCloseAllOnStop: true });
  stoppers.push(server.stop);
  const address = server.address as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    container,
    stop: server.stop,
    port: address.port,
  };
}

const stoppers: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];
afterEach(async () => {
  while (stoppers.length) await stoppers.pop()!();
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('GET /api/runs/:runId/events', () => {
  it('returns 400 for invalid runId format', async () => {
    const { baseUrl } = await bootServer();
    const r = await fetch(`${baseUrl}/api/runs/not-a-uuid/events`);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('invalid_id');
  });

  it('returns 404 for unknown run', async () => {
    const { baseUrl } = await bootServer();
    const r = await fetch(`${baseUrl}/api/runs/00000000-0000-0000-0000-000000000000/events`);
    expect(r.status).toBe(404);
  });

  it('returns events in ascending order', async () => {
    const { baseUrl, container } = await bootServer();
    const result = insertTestRun(container);
    container.eventRepository.insert({
      runUuid: result.uuid,
      level: 'info',
      type: 'run.started',
      message: 'begin',
      timestamp: new Date('2026-05-16T12:00:00.000Z'),
    });
    container.eventRepository.insert({
      runUuid: result.uuid,
      level: 'info',
      type: 'phase.completed',
      message: 'done',
      timestamp: new Date('2026-05-16T12:00:01.000Z'),
    });
    const r = await fetch(`${baseUrl}/api/runs/${result.uuid}/events`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { events: Array<{ type: string }> };
    expect(body.events.map((e) => e.type)).toEqual(['run.started', 'phase.completed']);
  });

  it('filters with ?since=ISO using strict-greater comparison', async () => {
    const { baseUrl, container } = await bootServer();
    const result = insertTestRun(container, 98);
    container.eventRepository.insert({
      runUuid: result.uuid,
      level: 'info',
      type: 'run.started',
      message: 'begin',
      timestamp: new Date('2026-05-16T12:00:00.000Z'),
    });
    container.eventRepository.insert({
      runUuid: result.uuid,
      level: 'info',
      type: 'phase.completed',
      message: 'done',
      timestamp: new Date('2026-05-16T12:00:01.000Z'),
    });
    const r = await fetch(
      `${baseUrl}/api/runs/${result.uuid}/events?since=2026-05-16T12:00:00.000Z`,
    );
    const body = (await r.json()) as { events: Array<{ type: string }> };
    expect(body.events.map((e) => e.type)).toEqual(['phase.completed']);
  });

  it('returns 400 for invalid since cursor', async () => {
    const { baseUrl, container } = await bootServer();
    const result = insertTestRun(container, 97);
    const r = await fetch(`${baseUrl}/api/runs/${result.uuid}/events?since=garbage`);
    expect(r.status).toBe(400);
  });

  it('serializes repoId in event response', async () => {
    const { baseUrl, container } = await bootServer();
    const repoId = RepositoryId('owner/repo');
    const result = insertTestRun(container, 96, repoId);
    container.eventRepository.insert({
      runUuid: result.uuid,
      level: 'info',
      type: 'run.started',
      message: 'begin',
      timestamp: new Date('2026-05-16T12:00:00.000Z'),
    });
    const r = await fetch(`${baseUrl}/api/runs/${result.uuid}/events`);
    const body = (await r.json()) as { events: Array<{ repoId: string }> };
    expect(body.events[0]?.repoId).toBe('owner/repo');
  });

  it('filters events by since timestamp', async () => {
    const { baseUrl, container } = await bootServer();
    const result = insertTestRun(container);
    container.eventRepository.insert({
      runUuid: result.uuid,
      level: 'info',
      type: 'run.started',
      message: 'first',
      timestamp: new Date('2026-05-16T12:00:00.000Z'),
    });
    container.eventRepository.insert({
      runUuid: result.uuid,
      level: 'info',
      type: 'run.completed',
      message: 'second',
      timestamp: new Date('2026-05-16T12:01:00.000Z'),
    });
    const r = await fetch(
      `${baseUrl}/api/runs/${result.uuid}/events?since=2026-05-16T12:00:30.000Z`,
    );
    const body = (await r.json()) as { events: Array<{ type: string }> };
    expect(body.events.length).toBe(1);
    expect(body.events[0]?.type).toBe('run.completed');
  });
});

describe('GET /api/runs/:runId/events/stream', () => {
  it('returns 400 for invalid run UUID format on SSE stream', async () => {
    const { baseUrl } = await bootServer();
    const r = await fetch(`${baseUrl}/api/runs/not-a-uuid/events/stream`);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toBe('invalid_id');
  });

  it('returns 404 for unknown run on SSE stream', async () => {
    const { baseUrl } = await bootServer();
    const r = await fetch(`${baseUrl}/api/runs/00000000-0000-0000-0000-000000000000/events/stream`);
    expect(r.status).toBe(404);
  });

  it('returns 400 for invalid since cursor on SSE stream', async () => {
    const { baseUrl, container } = await bootServer();
    const result = insertTestRun(container, 106);
    const r = await fetch(`${baseUrl}/api/runs/${result.uuid}/events/stream?since=garbage`);
    expect(r.status).toBe(400);
  });

  it('returns SSE stream with backfilled events', async () => {
    const { container, port } = await bootServer();
    const result = insertTestRun(container, 101);
    container.eventRepository.insert({
      runUuid: result.uuid,
      level: 'info',
      type: 'run.started',
      message: 'begin',
      timestamp: new Date('2026-05-16T12:00:00.000Z'),
    });

    const body = await new Promise<string>((resolve, reject) => {
      const req = http.get(
        `http://127.0.0.1:${port}/api/runs/${result.uuid}/events/stream`,
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers['content-type']).toMatch(/text\/event-stream/);
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
            if (data.includes('run.started')) {
              req.destroy();
              resolve(data);
            }
          });
          setTimeout(() => {
            req.destroy();
            resolve(data);
          }, 2000);
        },
      );
      req.on('error', reject);
    });

    expect(body).toContain('run.started');
    expect(body).toContain('id:');
    expect(body).toContain('data:');
  });

  it('sends live events via event bus after backfill', async () => {
    const { container, port } = await bootServer();
    const result = insertTestRun(container, 102);

    const body = await new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const req = http.get(
        `http://127.0.0.1:${port}/api/runs/${result.uuid}/events/stream`,
        (res) => {
          expect(res.statusCode).toBe(200);
          let data = '';
          // Wait for initial response, then publish a live event
          // The subscription is registered synchronously in the route handler,
          // so by the time we receive data chunks, subscribe is active.
          // Use a small delay to ensure the Node HTTP response callback has fired
          // and the handler has fully executed.
          setTimeout(() => {
            container.eventBus.publish(result.uuid, {
              runId: result.displayId,
              level: 'info',
              type: 'phase.started',
              message: 'planning',
              timestamp: '2026-05-16T12:00:02.000Z',
              metadata: {},
            });
          }, 50);

          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
            if (data.includes('phase.started')) {
              clearTimeout(timer);
              req.destroy();
              resolve(data);
            }
          });
          timer = setTimeout(() => {
            req.destroy();
            resolve(data);
          }, 3000);
        },
      );
      req.on('error', (err) => reject(err));
    });

    expect(body).toContain('phase.started');
  });

  it('skips events already sent during backfill (dedup on reconnect)', async () => {
    const { container, port } = await bootServer();
    const result = insertTestRun(container, 103);
    const ts = '2026-05-16T12:00:00.000Z';
    container.eventRepository.insert({
      runUuid: result.uuid,
      level: 'info',
      type: 'run.started',
      message: 'begin',
      timestamp: new Date(ts),
    });

    // Request stream starting from the backfilled event's timestamp
    // The backfill sends it (strict > would exclude it, but since filter uses strict >
    // we want to test that a live event with that timestamp isn't duplicated)
    const body = await new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const req = http.get(
        `http://127.0.0.1:${port}/api/runs/${result.uuid}/events/stream?since=2026-05-16T12:00:00.000Z`,
        (res) => {
          expect(res.statusCode).toBe(200);
          let data = '';

          // Wait for connection, then emit a live event
          setTimeout(() => {
            container.eventBus.publish(result.uuid, {
              runId: result.displayId,
              level: 'info',
              type: 'phase.completed',
              message: 'done',
              timestamp: '2026-05-16T12:00:01.000Z',
              metadata: {},
            });
          }, 50);

          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
            if (data.includes('phase.completed')) {
              clearTimeout(timer);
              req.destroy();
              resolve(data);
            }
          });
          timer = setTimeout(() => {
            req.destroy();
            resolve(data);
          }, 3000);
        },
      );
      req.on('error', (err) => reject(err));
    });

    expect(body).not.toContain('"run.started"');
    expect(body).toContain('phase.completed');
  });

  it('receives live events published after SSE connection is established', async () => {
    const { container, port } = await bootServer();
    const result = insertTestRun(container, 104);
    container.eventRepository.insert({
      runUuid: result.uuid,
      level: 'info',
      type: 'run.started',
      message: 'begin',
      timestamp: new Date('2026-05-16T12:00:00.000Z'),
    });

    // Publish a live event on the bus while backfill is happening.
    // Because subscribe-before-backfill is used, this event is queued
    // during backfill and sent after backfill completes, with dedup
    // against backfilled events.
    const liveEvent_ts = '2026-05-16T12:00:01.000Z';

    const body = await new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const req = http.get(
        `http://127.0.0.1:${port}/api/runs/${result.uuid}/events/stream`,
        (res) => {
          expect(res.statusCode).toBe(200);
          let data = '';

          // Publish immediately — the subscribe-before-backfill approach
          // means the bus subscription is already active, so this event
          // gets queued during backfill and sent afterward.
          container.eventBus.publish(result.uuid, {
            runId: result.displayId,
            level: 'info',
            type: 'phase.completed',
            message: 'live-during-backfill',
            timestamp: liveEvent_ts,
            metadata: {},
          });

          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
            if (data.includes('phase.completed')) {
              clearTimeout(timer);
              req.destroy();
              resolve(data);
            }
          });
          timer = setTimeout(() => {
            req.destroy();
            resolve(data);
          }, 3000);
        },
      );
      req.on('error', (err) => reject(err));
    });

    // Both backfilled and live-during-backfill events should appear
    expect(body).toContain('run.started');
    expect(body).toContain('phase.completed');
    expect(body).toContain('live-during-backfill');
  });

  it('deduplicates live event against backfill when timestamps match', async () => {
    const { container, port } = await bootServer();
    const result = insertTestRun(container, 105);
    const ts = '2026-05-16T12:00:00.000Z';
    container.eventRepository.insert({
      runUuid: result.uuid,
      level: 'info',
      type: 'run.started',
      message: 'begin',
      timestamp: new Date(ts),
    });

    const body = await new Promise<string>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const req = http.get(
        `http://127.0.0.1:${port}/api/runs/${result.uuid}/events/stream`,
        (res) => {
          expect(res.statusCode).toBe(200);
          let data = '';

          // Publish a live event with the same timestamp as the backfilled event.
          // It should be deduplicated (skipped) since ev.timestamp <= lastTimestamp.
          container.eventBus.publish(result.uuid, {
            runId: result.displayId,
            level: 'info',
            type: 'run.started',
            message: 'duplicate',
            timestamp: ts,
            metadata: {},
          });

          // Also publish a newer event that should NOT be deduped
          container.eventBus.publish(result.uuid, {
            runId: result.displayId,
            level: 'info',
            type: 'phase.completed',
            message: 'after-backfill',
            timestamp: '2026-05-16T12:00:01.000Z',
            metadata: {},
          });

          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
            if (data.includes('phase.completed')) {
              clearTimeout(timer);
              req.destroy();
              resolve(data);
            }
          });
          timer = setTimeout(() => {
            req.destroy();
            resolve(data);
          }, 3000);
        },
      );
      req.on('error', (err) => reject(err));
    });

    expect(body).toContain('run.started');
    expect(body).toContain('phase.completed');
    expect(body).not.toContain('duplicate');
    expect(body).toContain('after-backfill');
  });
});
