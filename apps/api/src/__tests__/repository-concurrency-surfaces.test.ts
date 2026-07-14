import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';
import { buildServer } from '../server.js';
import { composeRoot, type Container } from '../compose.js';

async function buildApp(): Promise<{ app: Awaited<ReturnType<typeof buildServer>>; c: Container }> {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-repo-concurrency-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  const c = composeRoot({
    repoRoot: dir,
    scriptPath: 'unused',
    metadataResolver: {
      resolve: () => ({
        rootPath: dir,
        nameWithOwner: 'acme/widgets',
        defaultBranch: 'main',
        remoteUrl: 'git@github.com:acme/widgets.git',
      }),
    },
  });
  const app = await buildServer(c, false);
  return { app, c };
}

describe('PATCH /api/repositories/:id maxConcurrentRuns', () => {
  it('persists repository_cap_one_is_persisted', async () => {
    const { app, c } = await buildApp();
    const repo = c.registerRepository.execute({ localPath: '/repos/widgets' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/repositories/${repo.id}`,
      payload: { maxConcurrentRuns: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().maxConcurrentRuns).toBe(1);
    await app.close();
  });

  it('returns repository_cap_round_trips_on_wire', async () => {
    const { app, c } = await buildApp();
    const repo = c.registerRepository.execute({ localPath: '/repos/widgets' });
    await app.inject({
      method: 'PATCH',
      url: `/api/repositories/${repo.id}`,
      payload: { maxConcurrentRuns: 1 },
    });
    const listRes = await app.inject({ method: 'GET', url: '/api/repositories' });
    expect(listRes.json().repositories[0].maxConcurrentRuns).toBe(1);
    await app.close();
  });

  it('rejects repository_cap_above_one_fails_closed', async () => {
    const { app, c } = await buildApp();
    const repo = c.registerRepository.execute({ localPath: '/repos/widgets' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/repositories/${repo.id}`,
      payload: { maxConcurrentRuns: 2 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/maxConcurrentRuns must be 1/);
    await app.close();
  });
});
