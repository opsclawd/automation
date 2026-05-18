import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot, type Container } from '../compose.js';
import { startServer } from '../server.js';

async function bootServer(): Promise<{
  baseUrl: string;
  container: Container;
  stop: () => Promise<void>;
}> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ai-orch-events-'));
  tempDirs.push(repoRoot);
  const scriptPath = join(repoRoot, 'fake.sh');
  writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\nexit 0\n');
  chmodSync(scriptPath, 0o755);
  const container = composeRoot({ repoRoot, scriptPath });
  const server = await startServer({ container, port: 0, forceCloseAllOnStop: true });
  stoppers.push(server.stop);
  const address = server.address as { port: number };
  return { baseUrl: `http://127.0.0.1:${address.port}`, container, stop: server.stop };
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

  it('returns events for a run in ascending order', async () => {
    const { baseUrl, container } = await bootServer();
    const result = await container.startIssueRun.execute({ issueNumber: 99 });
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
    const result = await container.startIssueRun.execute({ issueNumber: 98 });
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
    const result = await container.startIssueRun.execute({ issueNumber: 97 });
    const r = await fetch(`${baseUrl}/api/runs/${result.uuid}/events?since=garbage`);
    expect(r.status).toBe(400);
  });
});
