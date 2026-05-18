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

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
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
    const errors: string[] = [];
    const tailer = new EventTailer({
      path,
      onEvent: (e) => seen.push(e),
      onParseError: (_err, line) => errors.push(line),
      pollIntervalMs: 20,
    });
    await tailer.start();
    appendFileSync(path, ev('a') + '\n');
    appendFileSync(path, 'this-is-not-json\n');
    appendFileSync(path, ev('b') + '\n');
    await waitUntil(() => seen.length === 2 && errors.length >= 1, 1000);
    expect(seen.map((e) => e.type)).toEqual(['a', 'b']);
    expect(errors).toHaveLength(1);
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

  it('resets offset on file truncation', async () => {
    const seen: OrchestratorEvent[] = [];
    const tailer = new EventTailer({
      path,
      onEvent: (e) => seen.push(e),
      pollIntervalMs: 20,
    });
    await tailer.start();
    appendFileSync(path, ev('a') + '\n');
    await waitUntil(() => seen.length === 1, 2000);
    await new Promise((r) => setTimeout(r, 100));
    writeFileSync(path, ev('b') + '\n');
    await waitUntil(() => seen.length >= 2, 3000);
    expect(seen.map((e) => e.type)).toContain('b');
    await tailer.stop();
  });

  it('reads existing content on start', async () => {
    appendFileSync(path, ev('existing') + '\n');
    const seen: OrchestratorEvent[] = [];
    const tailer = new EventTailer({ path, onEvent: (e) => seen.push(e), pollIntervalMs: 20 });
    await tailer.start();
    await waitUntil(() => seen.length === 1, 1000);
    expect(seen[0]!.type).toBe('existing');
    await tailer.stop();
  });

  it('handles file not existing gracefully (ENOENT)', async () => {
    const seen: OrchestratorEvent[] = [];
    const nonExistent = join(dir, 'does-not-exist.jsonl');
    const tailer = new EventTailer({
      path: nonExistent,
      onEvent: (e) => seen.push(e),
      pollIntervalMs: 20,
    });
    await tailer.start();
    writeFileSync(nonExistent, ev('late') + '\n');
    await waitUntil(() => seen.length === 1, 2000);
    expect(seen[0]!.type).toBe('late');
    await tailer.stop();
  });
});
