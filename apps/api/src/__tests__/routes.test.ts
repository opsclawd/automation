import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot, type Container } from '../compose.js';
import { startServer } from '../server.js';

let nextPort = 4400;

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
  const port = nextPort++;
  const server = await startServer({ container, port });
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
    const { baseUrl, stop } = await bootServer({ withRun: true });
    stoppers.push(stop);
    const r = await fetch(`${baseUrl}/api/runs`);
    const body = (await r.json()) as { runs: Array<{ issueNumber: number }> };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0]!.issueNumber).toBe(1);
  });

  it('returns 404 for an unknown run id', async () => {
    const { baseUrl, stop } = await bootServer();
    stoppers.push(stop);
    const r = await fetch(`${baseUrl}/api/runs/does-not-exist`);
    expect(r.status).toBe(404);
  });

  it('returns 400 when the artifact path tries to escape the run directory', async () => {
    const { baseUrl, container, stop } = await bootServer({ withRun: true });
    stoppers.push(stop);
    const run = container.runRepository.list()[0]!;
    const r = await fetch(
      `${baseUrl}/api/runs/${run.uuid}/artifacts/${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(r.status).toBe(400);
  });

  it('serves combined.log as text/plain', async () => {
    const { baseUrl, container, stop } = await bootServer({ withRun: true });
    stoppers.push(stop);
    const run = container.runRepository.list()[0]!;
    const r = await fetch(`${baseUrl}/api/runs/${run.uuid}/artifacts/combined.log`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await r.text()).toContain('ok');
  });
});
