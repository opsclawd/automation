import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';
import { RunRepository } from '../run-repository.js';
import { FailureRepository } from '../failure-repository.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-fa-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('FailureRepository', () => {
  it('inserts a failure and findLatestByRun returns the most recent', () => {
    const db = freshDb();
    const runs = new RunRepository(db);
    const repo = new FailureRepository(db);

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
      runUuid: 'r',
      kind: 'timeout',
      message: 'attempt 1',
      canRetry: true,
      suggestedAction: 'retry',
      artifacts: [],
      detectedAt: new Date('2026-05-13T00:00:10Z'),
      attempt: 1,
    });
    repo.insert({
      runUuid: 'r',
      kind: 'timeout',
      message: 'attempt 2',
      canRetry: false,
      suggestedAction: 'escalate',
      artifacts: [],
      detectedAt: new Date('2026-05-13T00:00:20Z'),
      attempt: 2,
    });

    const latest = repo.findLatestByRun('r');
    expect(latest?.message).toBe('attempt 2');
    expect(latest?.attempt).toBe(2);
    expect(latest?.canRetry).toBe(false);
    db.close();
  });

  it('returns undefined when no failures exist', () => {
    const db = freshDb();
    const runs = new RunRepository(db);
    const repo = new FailureRepository(db);

    runs.insert({
      uuid: 'r',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });

    expect(repo.findLatestByRun('r')).toBeUndefined();
    db.close();
  });
});
