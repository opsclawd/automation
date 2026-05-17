import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot, type Container } from '../compose.js';
import { startServer } from '../server.js';

async function bootServer(opts: { withRun?: boolean } = {}): Promise<{
  baseUrl: string;
  container: Container;
  stop: () => Promise<void>;
}> {
  const repoRoot = mkdtempSync(join(tmpdir(), 'ai-orch-api-'));
  tempDirs.push(repoRoot);
  const scriptPath = join(repoRoot, 'fake.sh');
  writeFileSync(scriptPath, '#!/usr/bin/env bash\necho ok\nexit 0\n');
  chmodSync(scriptPath, 0o755);
  const container = composeRoot({ repoRoot, scriptPath });
  if (opts.withRun) await container.startIssueRun.execute({ issueNumber: 1 });
  const server = await startServer({ container, port: 0, forceCloseAllOnStop: true });
  stoppers.push(server.stop);
  const address = server.address as { port: number };
  const port = address.port;
  return { baseUrl: `http://127.0.0.1:${port}`, container, stop: server.stop };
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

describe('routes', () => {
  it('lists runs', async () => {
    const { baseUrl } = await bootServer({ withRun: true });
    const r = await fetch(`${baseUrl}/api/runs`);
    const body = (await r.json()) as { runs: Array<{ issueNumber: number }>; total: number };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0]!.issueNumber).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/runs accepts limit/offset and returns total', async () => {
    const { baseUrl, container } = await bootServer({ withRun: true });
    for (let i = 2; i <= 4; i++) {
      await container.startIssueRun.execute({ issueNumber: i });
    }
    const r = await fetch(`${baseUrl}/api/runs?limit=2&offset=1`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      runs: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.runs.length).toBe(2);
    expect(body.total).toBe(4);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
  });

  it('returns 400 for invalid runId format', async () => {
    const { baseUrl } = await bootServer();
    const r = await fetch(`${baseUrl}/api/runs/not-a-uuid`);
    expect(r.status).toBe(400);
  });

  it('returns 404 for an unknown valid UUID', async () => {
    const { baseUrl } = await bootServer();
    const r = await fetch(`${baseUrl}/api/runs/00000000-0000-0000-0000-000000000000`);
    expect(r.status).toBe(404);
  });

  it('returns 400 when the artifact path tries to escape the run directory', async () => {
    const { baseUrl, container } = await bootServer({ withRun: true });
    const run = container.runRepository.list({ limit: undefined }).runs[0]!;
    const r = await fetch(
      `${baseUrl}/api/runs/${run.uuid}/artifacts/${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(r.status).toBe(400);
  });

  it('returns 400 when the artifact path is an absolute path (URL-encoded)', async () => {
    const { baseUrl, container } = await bootServer({ withRun: true });
    const run = container.runRepository.list({ limit: undefined }).runs[0]!;
    const r = await fetch(
      `${baseUrl}/api/runs/${run.uuid}/artifacts/${encodeURIComponent('/etc/passwd')}`,
    );
    expect(r.status).toBe(400);
  });

  it('serves combined.log as text/plain', async () => {
    const { baseUrl, container } = await bootServer({ withRun: true });
    const run = container.runRepository.list({ limit: undefined }).runs[0]!;
    const r = await fetch(`${baseUrl}/api/runs/${run.uuid}/artifacts/combined.log`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await r.text()).toContain('ok');
  });

  it('returns empty files list when run directory is missing from disk', async () => {
    const { baseUrl, container } = await bootServer({ withRun: true });
    const run = container.runRepository.list({ limit: undefined }).runs[0]!;
    const runsDir = join(container.runsDir, run.displayId);
    rmSync(runsDir, { recursive: true, force: true });
    const r = await fetch(`${baseUrl}/api/runs/${run.uuid}/artifacts`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { files: Array<{ path: string }> };
    expect(body.files).toEqual([]);
  });

  it('does not infinite-loop on a symlink cycle', async () => {
    const { baseUrl, container } = await bootServer({ withRun: true });
    const run = container.runRepository.list({ limit: undefined }).runs[0]!;
    const runsDir = join(container.runsDir, run.displayId);
    symlinkSync('.', join(runsDir, 'loop'));
    const r = await fetch(`${baseUrl}/api/runs/${run.uuid}/artifacts`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { files: Array<{ path: string }> };
    const loopEntries = body.files.filter((f) => f.path.startsWith('loop'));
    expect(loopEntries.length).toBeLessThanOrEqual(1);
  });
});
