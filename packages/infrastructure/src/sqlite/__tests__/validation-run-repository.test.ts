import { describe, it, expect } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';
import { ValidationRunRepository } from '../validation-run-repository.js';
import { RunId, PhaseName, type ValidationRun } from '@ai-sdlc/domain';

const RUN_UUID = '22222222-2222-2222-2222-222222222222';

function seedRun(db: ReturnType<typeof openDatabase>): void {
  db.prepare(
    `INSERT INTO runs (uuid, display_id, issue_number, type, status, started_at, completed_phases)
     VALUES (?, 'run-x', 7, 'issue', 'running', datetime('now'), '[]')`,
  ).run(RUN_UUID);
}

function sampleRun(): ValidationRun {
  return {
    id: 'vrun-1',
    runId: RunId(RUN_UUID),
    phaseId: PhaseName('validate'),
    startedAt: new Date('2026-05-28T10:00:00Z'),
    completedAt: new Date('2026-05-28T10:01:00Z'),
    commands: [
      {
        command: 'pnpm build',
        exitCode: 0,
        durationMs: 100,
        stdoutPath: 'validate/0-build.stdout.log',
        stderrPath: 'validate/0-build.stderr.log',
        outcome: 'passed',
        kind: 'build',
      },
      {
        command: 'pnpm typecheck',
        exitCode: 2,
        durationMs: 200,
        stdoutPath: 'validate/1-typecheck.stdout.log',
        stderrPath: 'validate/1-typecheck.stderr.log',
        outcome: 'failed',
        kind: 'typecheck',
        classifier: '12 errors',
      },
    ],
  };
}

describe('ValidationRunRepository', () => {
  it('round-trips a validation run with ordered commands and nullable fields', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    seedRun(db);
    const repo = new ValidationRunRepository(db);

    repo.save(sampleRun());
    const got = repo.findById('vrun-1');

    expect(got).not.toBeNull();
    expect(got!.runId).toBe(RUN_UUID);
    expect(got!.phaseId).toBe('validate');
    expect(got!.startedAt.toISOString()).toBe('2026-05-28T10:00:00.000Z');
    expect(got!.completedAt?.toISOString()).toBe('2026-05-28T10:01:00.000Z');
    expect(got!.commands).toHaveLength(2);
    expect(got!.commands[0].command).toBe('pnpm build');
    expect(got!.commands[0].kind).toBe('build');
    expect(got!.commands[0].classifier).toBeUndefined();
    expect(got!.commands[1].outcome).toBe('failed');
    expect(got!.commands[1].classifier).toBe('12 errors');
    db.close();
  });

  it('listByRun returns runs for a run id', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    seedRun(db);
    const repo = new ValidationRunRepository(db);
    repo.save(sampleRun());
    const list = repo.listByRun(RunId(RUN_UUID));
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('vrun-1');
    db.close();
  });

  it('save is idempotent — re-saving replaces child rows', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    seedRun(db);
    const repo = new ValidationRunRepository(db);
    repo.save(sampleRun());
    const reduced = { ...sampleRun(), commands: [sampleRun().commands[0]] };
    repo.save(reduced);
    const got = repo.findById('vrun-1');
    expect(got!.commands).toHaveLength(1);
    db.close();
  });

  it('findById returns null for unknown id', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const repo = new ValidationRunRepository(db);
    expect(repo.findById('nope')).toBeNull();
    db.close();
  });

  it('save round-trips a run with zero commands', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    seedRun(db);
    const repo = new ValidationRunRepository(db);
    const empty = { ...sampleRun(), commands: [] };
    repo.save(empty);
    const got = repo.findById('vrun-1');
    expect(got!.commands).toHaveLength(0);
    db.close();
  });
});
