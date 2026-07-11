import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeRoot, type Container } from '../compose.js';
import { startServer } from '../server.js';
import { RepositoryId } from '@ai-sdlc/domain';

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
  const container = composeRoot({ repoRoot, scriptPath, repoFullName: 'owner/repo' });
  if (opts.withRun)
    await container.startIssueRun.execute({ issueNumber: 1, repoId: RepositoryId('owner/repo') });
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
      await container.startIssueRun.execute({ issueNumber: i, repoId: RepositoryId('owner/repo') });
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
    const run = container.runRepository.list().runs[0]!;
    const r = await fetch(
      `${baseUrl}/api/runs/${run.uuid}/artifacts/${encodeURIComponent('../../etc/passwd')}`,
    );
    expect(r.status).toBe(400);
  });

  it('returns 400 when the artifact path is an absolute path (URL-encoded)', async () => {
    const { baseUrl, container } = await bootServer({ withRun: true });
    const run = container.runRepository.list().runs[0]!;
    const r = await fetch(
      `${baseUrl}/api/runs/${run.uuid}/artifacts/${encodeURIComponent('/etc/passwd')}`,
    );
    expect(r.status).toBe(400);
  });

  it('serves combined.log as text/plain', async () => {
    const { baseUrl, container } = await bootServer({ withRun: true });
    const run = container.runRepository.list().runs[0]!;
    const r = await fetch(`${baseUrl}/api/runs/${run.uuid}/artifacts/combined.log`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await r.text()).toContain('ok');
  });

  it('returns empty files list when run directory is missing from disk', async () => {
    const { baseUrl, container } = await bootServer({ withRun: true });
    const run = container.runRepository.list().runs[0]!;
    const runsDir = join(container.runsDir, run.displayId);
    rmSync(runsDir, { recursive: true, force: true });
    const r = await fetch(`${baseUrl}/api/runs/${run.uuid}/artifacts`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { files: Array<{ path: string }> };
    expect(body.files).toEqual([]);
  });

  it('does not infinite-loop on a symlink cycle', async () => {
    const { baseUrl, container } = await bootServer({ withRun: true });
    const run = container.runRepository.list().runs[0]!;
    const runsDir = join(container.runsDir, run.displayId);
    symlinkSync('.', join(runsDir, 'loop'));
    const r = await fetch(`${baseUrl}/api/runs/${run.uuid}/artifacts`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { files: Array<{ path: string }> };
    const loopEntries = body.files.filter((f) => f.path.startsWith('loop'));
    expect(loopEntries.length).toBeLessThanOrEqual(1);
  });

  it('returns 400 for negative limit', async () => {
    const { baseUrl } = await bootServer({ withRun: true });
    const r = await fetch(`${baseUrl}/api/runs?limit=-1`);
    expect(r.status).toBe(400);
  });

  it('returns 400 for zero limit', async () => {
    const { baseUrl } = await bootServer({ withRun: true });
    const r = await fetch(`${baseUrl}/api/runs?limit=0`);
    expect(r.status).toBe(400);
  });

  it('returns 400 for negative offset', async () => {
    const { baseUrl } = await bootServer({ withRun: true });
    const r = await fetch(`${baseUrl}/api/runs?offset=-5`);
    expect(r.status).toBe(400);
  });

  it('returns 400 for non-numeric limit', async () => {
    const { baseUrl } = await bootServer({ withRun: true });
    const r = await fetch(`${baseUrl}/api/runs?limit=abc`);
    expect(r.status).toBe(400);
  });

  it('returns 400 for scientific notation limit', async () => {
    const { baseUrl } = await bootServer({ withRun: true });
    const r = await fetch(`${baseUrl}/api/runs?limit=1e2`);
    expect(r.status).toBe(400);
  });

  it('returns 400 for unsafe-integer limit (exceeds MAX_SAFE_INTEGER)', async () => {
    const { baseUrl } = await bootServer({ withRun: true });
    const r = await fetch(`${baseUrl}/api/runs?limit=9007199254740993`);
    expect(r.status).toBe(400);
  });

  it('returns 400 for unsafe-integer offset (exceeds MAX_SAFE_INTEGER)', async () => {
    const { baseUrl } = await bootServer({ withRun: true });
    const r = await fetch(`${baseUrl}/api/runs?offset=9007199254740993`);
    expect(r.status).toBe(400);
  });

  it('clamps limit to max of 100', async () => {
    const { baseUrl } = await bootServer({ withRun: true });
    const r = await fetch(`${baseUrl}/api/runs?limit=999999`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { limit: number };
    expect(body.limit).toBe(100);
  });

  it('filters runs by status and repository context', async () => {
    const { baseUrl, container } = await bootServer({ withRun: true });
    // Register repo
    container.repositoryRegistry.register({
      id: RepositoryId('1234567890123456789012345678901234567890123456789012345678901234'),
      fullName: 'some/other-repo',
      owner: 'some',
      name: 'other-repo',
      localBasePath: '/tmp/some-other-repo',
      defaultBranch: 'main',
      remoteUrl: 'git@github.com:some/other-repo.git',
      enabled: true,
    });

    // Add a run for this repository
    await container.startIssueRun.execute({
      issueNumber: 42,
      repoId: RepositoryId('1234567890123456789012345678901234567890123456789012345678901234'),
    });

    // 1. Filter by status 'running'
    const res1 = await fetch(`${baseUrl}/api/runs?status=running`);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { runs: unknown[] };
    expect(body1.runs.length).toBe(2);

    // 2. Filter by status 'passed'
    const res2 = await fetch(`${baseUrl}/api/runs?status=passed`);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { runs: unknown[] };
    expect(body2.runs.length).toBe(0);

    // 3. Filter by repo sha256 id
    const res3 = await fetch(
      `${baseUrl}/api/runs?repositoryId=1234567890123456789012345678901234567890123456789012345678901234`,
    );
    expect(res3.status).toBe(200);
    const body3 = (await res3.json()) as { runs: unknown[] };
    expect(body3.runs.length).toBe(1);

    // 4. Filter by repo owner/name fullName (resolving canonicalized repo context)
    const res4 = await fetch(`${baseUrl}/api/runs?repositoryId=some/other-repo`);
    expect(res4.status).toBe(200);
    const body4 = (await res4.json()) as { runs: unknown[] };
    expect(body4.runs.length).toBe(1);

    // 5. Query parameter repo
    const res5 = await fetch(`${baseUrl}/api/runs?repo=some/other-repo`);
    expect(res5.status).toBe(200);
    const body5 = (await res5.json()) as { runs: unknown[] };
    expect(body5.runs.length).toBe(1);

    // 6. Header x-repository-id
    const res6 = await fetch(`${baseUrl}/api/runs`, {
      headers: {
        'x-repository-id': 'some/other-repo',
      },
    });
    expect(res6.status).toBe(200);
    const body6 = (await res6.json()) as { runs: unknown[] };
    expect(body6.runs.length).toBe(1);

    // 7. Non-existent repo -> 404 repository_not_found
    const res7 = await fetch(`${baseUrl}/api/runs?repositoryId=nonexistent/repo`);
    expect(res7.status).toBe(404);
    const body7 = (await res7.json()) as { error: string };
    expect(body7.error).toBe('repository_not_found');
  });
});
