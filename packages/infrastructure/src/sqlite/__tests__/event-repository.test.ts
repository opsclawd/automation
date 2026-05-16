import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';
import { RunRepository } from '../run-repository.js';
import { EventRepository } from '../event-repository.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-ev-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('EventRepository', () => {
  it('inserts an event and returns a monotonic row id', () => {
    const db = freshDb();
    const runs = new RunRepository(db);
    const repo = new EventRepository(db);

    runs.insert({
      uuid: 'r',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });

    const id1 = repo.insert({
      runUuid: 'r',
      level: 'info',
      type: 'phase.started',
      message: 'starting',
      timestamp: new Date('2026-05-13T00:00:01Z'),
    });
    const id2 = repo.insert({
      runUuid: 'r',
      level: 'info',
      type: 'phase.completed',
      message: 'done',
      timestamp: new Date('2026-05-13T00:00:02Z'),
    });
    expect(id2).toBeGreaterThan(id1);
    db.close();
  });

  it('lists events by run with since-cursor filtering', () => {
    const db = freshDb();
    const runs = new RunRepository(db);
    const repo = new EventRepository(db);

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
      level: 'info',
      type: 'run.started',
      message: 'begin',
      timestamp: new Date('2026-05-13T00:00:01Z'),
    });
    repo.insert({
      runUuid: 'r',
      level: 'info',
      type: 'phase.started',
      message: 'mid',
      timestamp: new Date('2026-05-13T00:00:30Z'),
    });
    repo.insert({
      runUuid: 'r',
      level: 'info',
      type: 'run.ended',
      message: 'end',
      timestamp: new Date('2026-05-13T01:00:00Z'),
    });

    const later = repo.listByRunSince('r', '2026-05-13T00:00:15Z');
    expect(later).toHaveLength(2);
    expect(later[0].type).toBe('phase.started');
    expect(later[1].type).toBe('run.ended');
    db.close();
  });

  it('stores and retrieves metadata as JSON', () => {
    const db = freshDb();
    const runs = new RunRepository(db);
    const repo = new EventRepository(db);

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
      level: 'info',
      type: 'phase.started',
      message: 'x',
      timestamp: new Date(),
      metadata: { attempt: 3, agent: 'coder' },
    });

    const events = repo.listByRunSince('r');
    expect(events[0].metadata).toEqual({ attempt: 3, agent: 'coder' });
    db.close();
  });
});
