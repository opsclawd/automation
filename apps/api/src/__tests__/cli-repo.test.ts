import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, applyMigrations } from '@ai-sdlc/infrastructure';
import { composeRoot } from '../compose.js';

function buildContainer() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-cli-repo-'));
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
  return { c, dir };
}

describe('CLI: orchestrator repo register', () => {
  it('inserts a repository row and lists it', () => {
    const { c } = buildContainer();
    const repo = c.registerRepository.execute({ localPath: '/repos/widgets' });
    expect(repo.fullName).toBe('acme/widgets');
    const listed = c.listRepositories.execute({ includeDisabled: true });
    expect(listed.find((r) => r.id === repo.id)).toBeDefined();
  });

  it('enable/disable/remove flow works end-to-end', () => {
    const { c } = buildContainer();
    const repo = c.registerRepository.execute({ localPath: '/repos/widgets' });
    const disabled = c.disableRepository.execute(repo.id);
    expect(disabled.enabled).toBe(false);
    const enabled = c.enableRepository.execute(repo.id);
    expect(enabled.enabled).toBe(true);
    c.removeRepository.execute(repo.id);
    expect(c.listRepositories.execute({ includeDisabled: true })).toHaveLength(0);
  });

  it('remove is rejected when an active run exists', () => {
    const { c } = buildContainer();
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
    expect(() => c.removeRepository.execute(repo.id)).toThrow(/active/);
  });
});
