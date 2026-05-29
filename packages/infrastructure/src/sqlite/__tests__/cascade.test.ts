import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';
import { RunRepository } from '../run-repository.js';
import { PhaseRepository } from '../phase-repository.js';
import { EventRepository } from '../event-repository.js';
import { ArtifactRepository } from '../artifact-repository.js';
import { FailureRepository } from '../failure-repository.js';
import { ValidationRunRepository } from '../validation-run-repository.js';
import { RunId, PhaseName } from '@ai-sdlc/domain';

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-cas-'));
  const db = openDatabase(join(dir, 'orch.sqlite'));
  applyMigrations(db);
  return db;
}

describe('foreign-key cascade', () => {
  it('deletes dependent rows when the parent run is deleted', () => {
    const db = fresh();
    const runs = new RunRepository(db);
    const phases = new PhaseRepository(db);
    const events = new EventRepository(db);
    const artifacts = new ArtifactRepository(db);
    const failures = new FailureRepository(db);

    runs.insert({
      uuid: 'u',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'failed',
      completedPhases: [],
      startedAt: new Date('2026-05-13T00:00:00Z'),
    });
    phases.upsert({
      id: 'p',
      runUuid: 'u',
      name: 'read_issue',
      status: 'failed',
      attempt: 1,
    });
    events.insert({
      runUuid: 'u',
      level: 'info',
      type: 'phase.started',
      message: 'x',
      timestamp: new Date('2026-05-13T00:00:01Z'),
    });
    artifacts.insert({
      id: 'a',
      runUuid: 'u',
      type: 'combined_log',
      path: 'combined.log',
      createdAt: new Date('2026-05-13T00:00:01Z'),
    });
    failures.insert({
      runUuid: 'u',
      kind: 'unknown',
      message: 'boom',
      canRetry: false,
      suggestedAction: '-',
      artifacts: [],
      detectedAt: new Date(),
    });

    db.prepare('DELETE FROM runs WHERE uuid = ?').run('u');

    expect(phases.listByRun('u')).toHaveLength(0);
    expect(events.listByRunSince('u')).toHaveLength(0);
    expect(artifacts.listByRun('u')).toHaveLength(0);
    expect(failures.findLatestByRun('u')).toBeUndefined();
    db.close();
  });

  it('cascades delete to validation_runs and validation_command_results', () => {
    const db = fresh();
    const RUN_UUID = '33333333-3333-3333-3333-333333333333';
    new RunRepository(db).insert({
      uuid: RUN_UUID,
      displayId: 'issue-9-20260529-000000',
      issueNumber: 9,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date(),
    });
    new ValidationRunRepository(db).save({
      id: 'vr-c',
      runId: RunId(RUN_UUID),
      phaseId: PhaseName('validate'),
      startedAt: new Date(),
      commands: [
        {
          command: 'pnpm build',
          exitCode: 0,
          durationMs: 1,
          stdoutPath: 'validate/0-build.stdout.log',
          stderrPath: 'validate/0-build.stderr.log',
          outcome: 'passed',
        },
      ],
    });
    db.prepare('DELETE FROM runs WHERE uuid = ?').run(RUN_UUID);
    expect((db.prepare('SELECT COUNT(*) as c FROM validation_runs').get() as { c: number }).c).toBe(
      0,
    );
    expect(
      (db.prepare('SELECT COUNT(*) as c FROM validation_command_results').get() as { c: number }).c,
    ).toBe(0);
    db.close();
  });
});
