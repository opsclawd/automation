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
  it('round-trips initialPreStepHead', () => {
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
      initialPreStepHead: 'baseline-sha',
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
    expect(steps[0].initialPreStepHead).toBe('baseline-sha');
    db.close();
  });

  it('does not overwrite an existing initialPreStepHead during upsert', () => {
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
      initialPreStepHead: 'baseline-sha',
    });

    repo.upsert({
      id: 's1',
      runId: 'r1',
      phaseId: 'implement',
      index: 0,
      title: 'Write the foo module',
      status: 'running',
      initialPreStepHead: 'later-sha',
    });

    repo.upsert({
      id: 's1',
      runId: 'r1',
      phaseId: 'implement',
      index: 0,
      title: 'Write the foo module',
      status: 'success',
    });

    expect(repo.findByIndex('r1', 'implement', 0)?.initialPreStepHead).toBe('baseline-sha');
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

  it('SQLite Step repository round-trips normalized revert counts', () => {
    const db = freshDb();
    const repo = new SqliteStepRepository(db);
    const runs = new RunRepository(db);
    insertRun(runs, 'r1');

    repo.upsert({
      id: 's1',
      runId: 'r1',
      phaseId: 'implement',
      index: 0,
      title: 'Task 0',
      status: 'success',
      revertCounts: {
        './src/foo.ts': 1,
        'src/foo.ts': 3,
        'src/../src/foo.ts': 2,
        'src/bar.ts': 5,
      },
    });

    const step = repo.findByIndex('r1', 'implement', 0)!;
    expect(step.revertCounts).toEqual({
      'src/foo.ts': 3,
      'src/bar.ts': 5,
    });

    const list = repo.listForRun('r1');
    expect(list[0]!.revertCounts).toEqual({
      'src/foo.ts': 3,
      'src/bar.ts': 5,
    });
    db.close();
  });

  it('SQLite Step repository decodes legacy and malformed revert counts safely', () => {
    const db = openDatabase(':memory:');
    db.exec(`
      CREATE TABLE steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        phase_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        started_at TEXT,
        completed_at TEXT,
        initial_pre_step_head TEXT,
        revert_counts TEXT
      );
    `);
    const repo = new SqliteStepRepository(db);

    // Manually insert malformed rows directly into the steps table
    const insertRaw = (id: string, idx: number, rawRevertCounts: string | null) => {
      db.prepare(
        `INSERT INTO steps (id, run_id, phase_id, idx, title, status, revert_counts)
         VALUES (?, 'r1', 'implement', ?, 'Title', 'failed', ?)`,
      ).run(id, idx, rawRevertCounts);
    };

    insertRaw('s-null', 0, null);
    insertRaw('s-empty', 1, '');
    insertRaw('s-whitespace', 2, '   ');
    insertRaw('s-badjson', 3, '{invalid json');
    insertRaw('s-array', 4, '["src/foo.ts"]');
    insertRaw('s-primitive', 5, '123');
    insertRaw(
      's-mixed',
      6,
      JSON.stringify({
        'src/valid.ts': 4,
        'src/negative.ts': -1,
        'src/fraction.ts': 2.5,
        'src/nan.ts': NaN,
        'src/inf.ts': Infinity,
        'src/notnum.ts': 'hello',
        './src/valid.ts': -10, // collision with invalid should not reduce valid
      }),
    );

    expect(repo.findByIndex('r1', 'implement', 0)!.revertCounts).toEqual({});
    expect(repo.findByIndex('r1', 'implement', 1)!.revertCounts).toEqual({});
    expect(repo.findByIndex('r1', 'implement', 2)!.revertCounts).toEqual({});
    expect(repo.findByIndex('r1', 'implement', 3)!.revertCounts).toEqual({});
    expect(repo.findByIndex('r1', 'implement', 4)!.revertCounts).toEqual({});
    expect(repo.findByIndex('r1', 'implement', 5)!.revertCounts).toEqual({});
    expect(repo.findByIndex('r1', 'implement', 6)!.revertCounts).toEqual({
      'src/valid.ts': 4,
    });
    db.close();
  });

  it('SQLite Step upsert preserves revert counts while updating unrelated fields', () => {
    const db = freshDb();
    const repo = new SqliteStepRepository(db);
    const runs = new RunRepository(db);
    insertRun(runs, 'r1');

    repo.upsert({
      id: 's1',
      runId: 'r1',
      phaseId: 'implement',
      index: 0,
      title: 'Initial Title',
      status: 'running',
      revertCounts: {
        'src/foo.ts': 2,
      },
    });

    // Update title and status with empty revertCounts (e.g. from an unrelated update)
    repo.upsert({
      id: 's1',
      runId: 'r1',
      phaseId: 'implement',
      index: 0,
      title: 'Updated Title',
      status: 'success',
      revertCounts: {},
    });

    const step = repo.findByIndex('r1', 'implement', 0)!;
    expect(step.title).toBe('Updated Title');
    expect(step.status).toBe('success');
    expect(step.revertCounts).toEqual({ 'src/foo.ts': 2 });

    // Now supply an explicit newer map
    repo.upsert({
      id: 's1',
      runId: 'r1',
      phaseId: 'implement',
      index: 0,
      title: 'Updated Title 2',
      status: 'running',
      revertCounts: {
        'src/foo.ts': 3,
        'src/bar.ts': 1,
      },
    });

    const step2 = repo.findByIndex('r1', 'implement', 0)!;
    expect(step2.revertCounts).toEqual({
      'src/foo.ts': 3,
      'src/bar.ts': 1,
    });
    db.close();
  });
});
