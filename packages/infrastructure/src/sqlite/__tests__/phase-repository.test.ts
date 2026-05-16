import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';
import { RunRepository } from '../run-repository.js';
import { PhaseRepository } from '../phase-repository.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-ph-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('PhaseRepository', () => {
  it('upserts a phase and lists by run', () => {
    const db = freshDb();
    const runs = new RunRepository(db);
    const repo = new PhaseRepository(db);

    runs.insert({
      uuid: 'r',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });

    repo.upsert({
      id: 'p1',
      runUuid: 'r',
      name: 'read_issue',
      status: 'running',
      attempt: 1,
      startedAt: new Date('2026-05-13T00:00:01Z'),
    });

    const phases = repo.listByRun('r');
    expect(phases).toHaveLength(1);
    expect(phases[0].name).toBe('read_issue');
    expect(phases[0].status).toBe('running');
    db.close();
  });

  it('upserts update an existing phase by id', () => {
    const db = freshDb();
    const runs = new RunRepository(db);
    const repo = new PhaseRepository(db);

    runs.insert({
      uuid: 'r',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });

    repo.upsert({
      id: 'p1',
      runUuid: 'r',
      name: 'read_issue',
      status: 'running',
      attempt: 1,
      startedAt: new Date('2026-05-13T00:00:01Z'),
    });
    repo.upsert({
      id: 'p1',
      runUuid: 'r',
      name: 'read_issue',
      status: 'passed',
      attempt: 1,
      startedAt: new Date('2026-05-13T00:00:01Z'),
      completedAt: new Date('2026-05-13T00:01:00Z'),
    });

    const phases = repo.listByRun('r');
    expect(phases).toHaveLength(1);
    expect(phases[0].status).toBe('passed');
    db.close();
  });

  it('lists phases ordered by startedAt ASC', () => {
    const db = freshDb();
    const runs = new RunRepository(db);
    const repo = new PhaseRepository(db);

    runs.insert({
      uuid: 'r',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });

    repo.upsert({
      id: 'p2',
      runUuid: 'r',
      name: 'write_code',
      status: 'pending',
      attempt: 1,
    });
    repo.upsert({
      id: 'p1',
      runUuid: 'r',
      name: 'read_issue',
      status: 'running',
      attempt: 1,
      startedAt: new Date('2026-05-13T00:00:01Z'),
    });

    const phases = repo.listByRun('r');
    expect(phases[0].name).toBe('write_code');
    expect(phases[1].name).toBe('read_issue');
    db.close();
  });
});
