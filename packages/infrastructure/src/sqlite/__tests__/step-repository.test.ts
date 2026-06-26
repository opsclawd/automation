import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';
import { RunRepository } from '../run-repository.js';
import { SqliteStepRepository } from '../step-repository.js';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-st-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

function insertRun(runs: RunRepository, uuid: string) {
  runs.insert({
    uuid,
    displayId: `issue-1-${uuid}`,
    issueNumber: 1,
    type: 'issue_to_pr',
    status: 'running',
    completedPhases: [],
    startedAt: new Date('2026-05-13T00:00:00Z'),
  });
}

describe('SqliteStepRepository', () => {
  it('round-trips a step', () => {
    const db = freshDb();
    const repo = new SqliteStepRepository(db);
    const runs = new RunRepository(db);
    insertRun(runs, 'r1');

    repo.upsert({
      id: 's1',
      runId: 'r1',
      phaseId: 'implement',
      index: 0,
      title: 'Write the foo module',
      status: 'success',
      startedAt: new Date('2026-05-13T00:01:00Z'),
      completedAt: new Date('2026-05-13T00:05:00Z'),
    });

    const steps = repo.listForRun('r1');
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe('s1');
    expect(steps[0].runId).toBe('r1');
    expect(steps[0].phaseId).toBe('implement');
    expect(steps[0].index).toBe(0);
    expect(steps[0].title).toBe('Write the foo module');
    expect(steps[0].status).toBe('success');
    expect(steps[0].startedAt).toBeInstanceOf(Date);
    expect(steps[0].startedAt!.toISOString()).toBe('2026-05-13T00:01:00.000Z');
    expect(steps[0].completedAt).toBeInstanceOf(Date);
    expect(steps[0].completedAt!.toISOString()).toBe('2026-05-13T00:05:00.000Z');
    db.close();
  });

  it('updates an existing step by composite key (run_id, phase_id, idx)', () => {
    const db = freshDb();
    const repo = new SqliteStepRepository(db);
    const runs = new RunRepository(db);
    insertRun(runs, 'r1');

    repo.upsert({
      id: 's1',
      runId: 'r1',
      phaseId: 'implement',
      index: 0,
      title: 'Write the foo module',
      status: 'running',
      startedAt: new Date('2026-05-13T00:01:00Z'),
    });
    repo.upsert({
      id: 's1',
      runId: 'r1',
      phaseId: 'implement',
      index: 0,
      title: 'Write the foo module',
      status: 'success',
      startedAt: new Date('2026-05-13T00:01:00Z'),
      completedAt: new Date('2026-05-13T00:05:00Z'),
    });

    const steps = repo.listForRun('r1');
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe('success');
    expect(steps[0].completedAt?.toISOString()).toBe('2026-05-13T00:05:00.000Z');
    db.close();
  });

  it('orders steps by canonical phase order then index', () => {
    const db = freshDb();
    const repo = new SqliteStepRepository(db);
    const runs = new RunRepository(db);
    insertRun(runs, 'r1');

    repo.upsert({
      id: 's3',
      runId: 'r1',
      phaseId: 'implement',
      index: 1,
      title: 'Step 2 of implement',
      status: 'pending',
    });
    repo.upsert({
      id: 's1',
      runId: 'r1',
      phaseId: 'read_issue',
      index: 0,
      title: 'Read issue',
      status: 'success',
    });
    repo.upsert({
      id: 's2',
      runId: 'r1',
      phaseId: 'implement',
      index: 0,
      title: 'Step 1 of implement',
      status: 'success',
    });

    const steps = repo.listForRun('r1');
    expect(steps).toHaveLength(3);
    expect(steps[0].phaseId).toBe('read_issue');
    expect(steps[0].index).toBe(0);
    expect(steps[1].phaseId).toBe('implement');
    expect(steps[1].index).toBe(0);
    expect(steps[2].phaseId).toBe('implement');
    expect(steps[2].index).toBe(1);
    db.close();
  });

  it('returns undefined for missing findByIndex', () => {
    const db = freshDb();
    const repo = new SqliteStepRepository(db);

    const found = repo.findByIndex('nonexistent', 'implement', 0);
    expect(found).toBeUndefined();
    db.close();
  });

  it('finds a step by composite key', () => {
    const db = freshDb();
    const repo = new SqliteStepRepository(db);
    const runs = new RunRepository(db);
    insertRun(runs, 'r1');

    repo.upsert({
      id: 's1',
      runId: 'r1',
      phaseId: 'implement',
      index: 0,
      title: 'Write the foo module',
      status: 'success',
    });

    const found = repo.findByIndex('r1', 'implement', 0);
    expect(found).toBeDefined();
    expect(found!.id).toBe('s1');
    expect(found!.title).toBe('Write the foo module');
    db.close();
  });

  it('maps ISO date strings to Date objects', () => {
    const db = freshDb();
    const repo = new SqliteStepRepository(db);
    const runs = new RunRepository(db);
    insertRun(runs, 'r1');

    const startedAt = new Date('2026-05-13T00:01:00.123Z');
    const completedAt = new Date('2026-05-13T00:05:30.456Z');

    repo.upsert({
      id: 's1',
      runId: 'r1',
      phaseId: 'plan-design',
      index: 0,
      title: 'Design the API',
      status: 'success',
      startedAt,
      completedAt,
    });

    const step = repo.findByIndex('r1', 'plan-design', 0)!;
    expect(step.startedAt!.toISOString()).toBe('2026-05-13T00:01:00.123Z');
    expect(step.completedAt!.toISOString()).toBe('2026-05-13T00:05:30.456Z');
    db.close();
  });

  it('handles step with no dates', () => {
    const db = freshDb();
    const repo = new SqliteStepRepository(db);
    const runs = new RunRepository(db);
    insertRun(runs, 'r1');

    repo.upsert({
      id: 's1',
      runId: 'r1',
      phaseId: 'read_issue',
      index: 0,
      title: 'Read the issue',
      status: 'pending',
    });

    const step = repo.findByIndex('r1', 'read_issue', 0)!;
    expect(step.startedAt).toBeUndefined();
    expect(step.completedAt).toBeUndefined();
    db.close();
  });
});
