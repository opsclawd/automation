import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';
import { buildServer } from '../server.js';
import { composeRoot, type Container } from '../compose.js';

async function buildApp(): Promise<{ app: Awaited<ReturnType<typeof buildServer>>; c: Container }> {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-repos-api-'));
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

describe('GET /api/repositories', () => {
  it('returns an empty list initially', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/repositories' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ repositories: [] });
    await app.close();
  });
});

describe('POST /api/repositories', () => {
  it('returns 201 with the wire repo on success', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      payload: { localPath: '/repos/widgets' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().fullName).toBe('acme/widgets');
    await app.close();
  });

  it('returns 400 on missing localPath', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/repositories',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('PATCH /api/repositories/:id', () => {
  it('toggles enabled via the body', async () => {
    const { app, c } = await buildApp();
    const repo = c.registerRepository.execute({ localPath: '/repos/widgets' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/repositories/${repo.id}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().enabled).toBe(false);
    await app.close();
  });
});

describe('DELETE /api/repositories/:id', () => {
  it('returns 204 when no active runs', async () => {
    const { app, c } = await buildApp();
    const repo = c.registerRepository.execute({ localPath: '/repos/widgets' });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/repositories/${repo.id}`,
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it('returns 409 when an active run exists', async () => {
    const { app, c } = await buildApp();
    const repo = c.registerRepository.execute({ localPath: '/repos/widgets' });
    c.runRepository.insertIfNoActive({
      uuid: 'run-1',
      displayId: 'run-1',
      issueNumber: 1,
      type: 'issue',
      status: 'running',
      startedAt: new Date(),
      completedPhases: [],
      completedAt: null,
      currentPhase: null,
      skippedPhases: [],
      failureReason: null,
      repoId: repo.id,
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/repositories/${repo.id}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().activeCount).toBe(1);
    await app.close();
  });
});
