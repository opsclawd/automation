import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
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
    it('refuses ambiguous legacy operational rows without opening a repository runtime', async () => {
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

      await expect(migrator.migrateLegacyState(repoIdA)).rejects.toThrow(MigrationError);
      await expect(migrator.migrateLegacyState(repoIdA)).rejects.toThrow(/ambiguous/i);
    });

    it('migrates legacy operational rows only when one eligible repository exists', async () => {
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

      const legacyEvents = new EventRepository(legacyDb, repoIdA);
      legacyEvents.insert({
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

      await migrator.migrateLegacyState(repoIdA);
    });
  });

  describe('artifact migration', () => {
    it('migrates artifacts from legacy root to operational root using artifactMover', async () => {
      const { db: legacyDb } = freshLegacyDb();
      const { db: operationalDb } = freshOperationalDb();
      const legacyArtifactRoot = mkdtempSync(join(tmpdir(), 'ai-orch-artifact-'));
      const operationalArtifactRoot = mkdtempSync(join(tmpdir(), 'ai-orch-op-artifact-'));

      writeFileSync(join(legacyArtifactRoot, 'artifact-1.txt'), 'artifact content 1');
      writeFileSync(join(legacyArtifactRoot, 'artifact-2.txt'), 'artifact content 2');

      const movedArtifacts: Array<{ src: string; dest: string }> = [];
      const migrator = new RepositoryRuntimeMigrator({
        controlPlaneDb: legacyDb,
        operationalDb: operationalDb,
        legacyArtifactRoot,
        operationalArtifactRoot,
        listEnabledRepositories: () => [{ id: repoIdA, fullName: 'owner/repo-a' }],
        artifactMover: async (src: string, dest: string) => {
          movedArtifacts.push({ src, dest });
          writeFileSync(dest, 'moved');
        },
      });

      await migrator.migrateLegacyState(repoIdA);

      expect(movedArtifacts).toHaveLength(2);
      expect(movedArtifacts.some((m) => m.src.includes('artifact-1.txt'))).toBe(true);
      expect(movedArtifacts.some((m) => m.src.includes('artifact-2.txt'))).toBe(true);
      expect(existsSync(join(operationalArtifactRoot, 'artifact-1.txt'))).toBe(true);
      expect(existsSync(join(operationalArtifactRoot, 'artifact-2.txt'))).toBe(true);
    });

    it('artifact_migration_is_idempotent: skips already-migrated artifacts via sentinel', async () => {
      const { db: legacyDb } = freshLegacyDb();
      const { db: operationalDb } = freshOperationalDb();
      const legacyArtifactRoot = mkdtempSync(join(tmpdir(), 'ai-orch-artifact-'));
      const operationalArtifactRoot = mkdtempSync(join(tmpdir(), 'ai-orch-op-artifact-'));

      writeFileSync(join(legacyArtifactRoot, 'artifact-1.txt'), 'artifact content 1');

      const movedArtifacts: Array<{ src: string; dest: string }> = [];
      const migrator = new RepositoryRuntimeMigrator({
        controlPlaneDb: legacyDb,
        operationalDb: operationalDb,
        legacyArtifactRoot,
        operationalArtifactRoot,
        listEnabledRepositories: () => [{ id: repoIdA, fullName: 'owner/repo-a' }],
        artifactMover: async (src: string, dest: string) => {
          movedArtifacts.push({ src, dest });
          writeFileSync(dest, 'moved');
        },
      });

      await migrator.migrateLegacyState(repoIdA);
      expect(movedArtifacts).toHaveLength(1);

      movedArtifacts.length = 0;
      await migrator.migrateLegacyState(repoIdA);
      expect(movedArtifacts).toHaveLength(0);
    });

    it('resumes after partial failure without duplicate artifacts', async () => {
      const { db: legacyDb } = freshLegacyDb();
      const { db: operationalDb } = freshOperationalDb();
      const legacyArtifactRoot = mkdtempSync(join(tmpdir(), 'ai-orch-artifact-'));
      const operationalArtifactRoot = mkdtempSync(join(tmpdir(), 'ai-orch-op-artifact-'));

      writeFileSync(join(legacyArtifactRoot, 'artifact-1.txt'), 'artifact content 1');
      writeFileSync(join(legacyArtifactRoot, 'artifact-2.txt'), 'artifact content 2');

      let shouldFail = true;
      const migrator = new RepositoryRuntimeMigrator({
        controlPlaneDb: legacyDb,
        operationalDb: operationalDb,
        legacyArtifactRoot,
        operationalArtifactRoot,
        listEnabledRepositories: () => [{ id: repoIdA, fullName: 'owner/repo-a' }],
        artifactMover: async (src: string, dest: string) => {
          if (shouldFail && src.includes('artifact-2.txt')) {
            throw new Error('simulated failure');
          }
          writeFileSync(dest, 'moved');
        },
      });

      await expect(migrator.migrateLegacyState(repoIdA)).rejects.toThrow(MigrationError);
      expect(existsSync(join(operationalArtifactRoot, 'artifact-1.txt'))).toBe(true);
      expect(existsSync(join(operationalArtifactRoot, 'artifact-2.txt'))).toBe(false);

      shouldFail = false;
      await migrator.migrateLegacyState(repoIdA);
      expect(existsSync(join(operationalArtifactRoot, 'artifact-1.txt'))).toBe(true);
      expect(existsSync(join(operationalArtifactRoot, 'artifact-2.txt'))).toBe(true);
    });
  });
});
