import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';
import { composeRoot, type Container } from '../compose.js';
import { buildServer } from '../server.js';

function freshContainer(): { c: Container; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-integ-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return {
    dir,
    c: composeRoot({
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
    }),
  };
}

describe('Repository registry integration', () => {
  it('register → list → disable → enable → remove (round-trip)', async () => {
    const { c, dir } = freshContainer();
    const repo = c.registerRepository.execute({ localPath: dir });
    expect(c.listRepositories.execute()).toHaveLength(1);

    const disabled = c.disableRepository.execute(repo.id);
    expect(disabled.enabled).toBe(false);

    const enabled = c.enableRepository.execute(repo.id);
    expect(enabled.enabled).toBe(true);

    c.removeRepository.execute(repo.id);
    expect(c.listRepositories.execute({ includeDisabled: true })).toHaveLength(0);
  });

  it('refresh updates defaultBranch and sets health=healthy', async () => {
    const { c, dir } = freshContainer();
    const repo = c.registerRepository.execute({ localPath: dir });
    const after = c.refreshRepository.execute(repo.id);
    expect(after.healthStatus).toBe('healthy');
  });

  it('removal is rejected while any non-terminal run exists', async () => {
    const { c, dir } = freshContainer();
    const repo = c.registerRepository.execute({ localPath: dir });
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
    expect(() => c.removeRepository.execute(repo.id)).toThrow(/active run/);
  });

  it('HTTP routes and CLI use cases share the same Container state', async () => {
    const { c, dir } = freshContainer();
    const app = await buildServer(c, false);
    const repo = c.registerRepository.execute({ localPath: dir });
    const res = await app.inject({ method: 'GET', url: `/api/repositories/${repo.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(repo.id);
    await app.close();
  });
});
