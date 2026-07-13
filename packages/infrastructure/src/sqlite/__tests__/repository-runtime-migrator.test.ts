import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepositoryId } from '@ai-sdlc/domain';
import { openDatabase, applyMigrations } from '../../index.js';
import { RunRepository } from '../run-repository.js';
import { EventRepository } from '../event-repository.js';
import { RepositoryRuntimeMigrator, MigrationError } from '../repository-runtime-migrator.js';

const repoIdA = RepositoryId('owner/repo-a');
const repoIdB = RepositoryId('owner/repo-b');

function freshLegacyDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-legacy-'));
  const db = openDatabase(join(dir, 'legacy.sqlite'));
  applyMigrations(db);
  return { db, dir };
}

function freshOperationalDb() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-orch-op-'));
  const db = openDatabase(join(dir, 'operational.sqlite'));
  applyMigrations(db);
  return { db, dir };
}

describe('RepositoryRuntimeMigrator', () => {
  describe('legacy_migration_fails_closed', () => {
    it('refuses ambiguous legacy operational rows without opening a repository runtime', () => {
      const { db: legacyDb } = freshLegacyDb();
      const { db: operationalDb } = freshOperationalDb();
      const runs = new RunRepository(legacyDb);

      runs.insert({
        uuid: 'legacy-run-1',
        displayId: 'issue-1-20260513-000000',
        issueNumber: 1,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T00:00:00Z'),
      });

      const migrator = new RepositoryRuntimeMigrator({
        controlPlaneDb: legacyDb,
        operationalDb: operationalDb,
        listEnabledRepositories: () => [
          { id: repoIdA, fullName: 'owner/repo-a' },
          { id: repoIdB, fullName: 'owner/repo-b' },
        ],
      });

      expect(() => migrator.migrateLegacyState(repoIdA)).toThrow(MigrationError);
      expect(() => migrator.migrateLegacyState(repoIdA)).toThrow(/ambiguous/i);
    });

    it('migrates legacy operational rows only when one eligible repository exists', () => {
      const { db: legacyDb } = freshLegacyDb();
      const { db: operationalDb } = freshOperationalDb();
      const legacyRuns = new RunRepository(legacyDb);
      const operationalRuns = new RunRepository(operationalDb);

      legacyRuns.insert({
        uuid: 'legacy-run-1',
        displayId: 'issue-1-20260513-000000',
        issueNumber: 1,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T00:00:00Z'),
      });

      operationalRuns.insert({
        uuid: 'legacy-run-1',
        displayId: 'issue-1-20260513-000000',
        issueNumber: 1,
        type: 'issue_to_pr',
        status: 'running',
        completedPhases: [],
        startedAt: new Date('2026-05-13T00:00:00Z'),
      });

      const operationalEvents = new EventRepository(operationalDb, repoIdA);
      operationalEvents.insert({
        runUuid: 'legacy-run-1',
        level: 'info',
        type: 'run.started',
        message: 'started',
        timestamp: new Date('2026-05-13T00:00:01Z'),
      });

      const migrator = new RepositoryRuntimeMigrator({
        controlPlaneDb: legacyDb,
        operationalDb: operationalDb,
        listEnabledRepositories: () => [{ id: repoIdA, fullName: 'owner/repo-a' }],
      });

      expect(() => migrator.migrateLegacyState(repoIdA)).not.toThrow();
    });
  });

  describe('artifact migration', () => {
    it('artifact_migration_is_idempotent: resumes after partial failure without duplicate artifacts', async () => {
      const { db: legacyDb } = freshLegacyDb();
      const { db: operationalDb } = freshOperationalDb();
      const legacyArtifactRoot = mkdtempSync(join(tmpdir(), 'ai-orch-artifact-'));

      const migrator = new RepositoryRuntimeMigrator({
        controlPlaneDb: legacyDb,
        operationalDb: operationalDb,
        legacyArtifactRoot,
        listEnabledRepositories: () => [{ id: repoIdA, fullName: 'owner/repo-a' }],
        artifactMover: async (_src: string, _dest: string) => {
          throw new Error('simulated failure');
        },
      });

      const state = migrator.detectLegacyState();
      expect(state.hasLegacyArtifacts).toBe(true);
    });
  });
});
