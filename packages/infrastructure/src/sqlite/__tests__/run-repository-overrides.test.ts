import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepositoryId } from '@ai-sdlc/domain';
import { openDatabase, applyMigrations } from '../../index.js';
import { RunRepository } from '../run-repository.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-db-overrides-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('RunRepository overrides', () => {
  it('persists and retrieves baseBranch, modelOverride, and runtimeOverride', () => {
    const db = freshDb();
    const repo = new RunRepository(db);
    repo.insert({
      uuid: 'u1',
      displayId: 'issue-1-20260513-000000',
      repoId: RepositoryId('owner/repo'),
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      skippedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
      baseBranch: 'develop',
      modelOverride: 'gpt-4o',
      runtimeOverride: 'pi',
    });

    const found = repo.findByUuid('u1');
    expect(found?.baseBranch).toBe('develop');
    expect(found?.modelOverride).toBe('gpt-4o');
    expect(found?.runtimeOverride).toBe('pi');
    db.close();
  });
});
