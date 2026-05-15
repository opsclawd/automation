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
});
