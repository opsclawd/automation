import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';
import { RunRepository } from '../run-repository.js';
import { ArtifactRepository } from '../artifact-repository.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-ar-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('ArtifactRepository', () => {
  it('inserts and lists artifacts for a run', () => {
    const db = freshDb();
    const runs = new RunRepository(db);
    const repo = new ArtifactRepository(db);

    runs.insert({
      uuid: 'r',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });

    repo.insert({
      id: 'a1',
      runUuid: 'r',
      type: 'combined_log',
      path: 'combined.log',
      createdAt: new Date('2026-05-13T00:00:01Z'),
    });
    repo.insert({
      id: 'a2',
      runUuid: 'r',
      type: 'diff',
      path: 'changes.diff',
      createdAt: new Date('2026-05-13T00:00:02Z'),
    });

    const artifacts = repo.listByRun('r');
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].type).toBe('combined_log');
    expect(artifacts[1].path).toBe('changes.diff');
    db.close();
  });
});
