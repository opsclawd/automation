import { access, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './database.js';
import type { RepositoryId } from '@ai-sdlc/domain';

const MIGRATION_SENTINEL = '.migration-complete';

export interface LegacyOperationalState {
  hasLegacyEvents: boolean;
  legacyArtifactRoot?: string;
}

export interface RepositoryRuntimeMigratorDeps {
  controlPlaneDb: Db;
  operationalDb: Db;
  legacyArtifactRoot?: string;
  listEnabledRepositories: () => Array<{ id: RepositoryId; fullName: string }>;
  artifactMover?: (src: string, dest: string) => Promise<void>;
  operationalArtifactRoot?: string;
}

export class RepositoryRuntimeMigrator {
  constructor(private readonly deps: RepositoryRuntimeMigratorDeps) {}

  detectLegacyState(): LegacyOperationalState {
    const { controlPlaneDb, legacyArtifactRoot } = this.deps;

    const eventsWithoutRepoId = (
      controlPlaneDb.prepare(`SELECT COUNT(*) as c FROM events WHERE repo_id IS NULL`).get() as {
        c: number;
      }
    ).c;

    return {
      hasLegacyEvents: eventsWithoutRepoId > 0,
      ...(legacyArtifactRoot !== undefined ? { legacyArtifactRoot } : {}),
    };
  }

  findEligibleRepositories(): Array<{ id: RepositoryId; fullName: string }> {
    return this.deps.listEnabledRepositories();
  }

  async migrateLegacyState(targetRepoId: RepositoryId): Promise<void> {
    const eligible = this.findEligibleRepositories();

    if (eligible.length === 0) {
      throw new MigrationError(
        `Migration failed: no eligible repositories found. Cannot determine ownership of legacy operational state.`,
        'no_eligible_repositories',
      );
    }

    if (eligible.length > 1) {
      throw new MigrationError(
        `Migration failed: ${eligible.length} eligible repositories found. Legacy operational state ownership is ambiguous. Found: ${eligible.map((r) => r.fullName).join(', ')}.`,
        'ambiguous_ownership',
      );
    }

    const soleRepo = eligible[0]!;

    if (soleRepo.id !== targetRepoId) {
      throw new MigrationError(
        `Migration failed: legacy operational state belongs to '${soleRepo.fullName}' but requested repository is '${targetRepoId}'. No migration performed.`,
        'repository_mismatch',
      );
    }

    this.migrateEvents(targetRepoId);
    await this.migrateArtifacts();
  }

  private migrateEvents(repoId: RepositoryId): void {
    const { controlPlaneDb, operationalDb } = this.deps;

    const unownedEvents = controlPlaneDb
      .prepare(`SELECT * FROM events WHERE repo_id IS NULL`)
      .all() as Array<{
      id: number;
      run_uuid: string;
      phase: string;
      level: string;
      type: string;
      message: string;
      metadata: unknown;
      timestamp: string;
    }>;

    if (unownedEvents.length === 0) {
      return;
    }

    const eventIds = unownedEvents.map((e) => e.id);

    const migrateTx = operationalDb.transaction(() => {
      for (const event of unownedEvents) {
        const existing = operationalDb
          .prepare(
            `SELECT id FROM events WHERE run_uuid = ? AND timestamp = ? AND type = ? AND message = ?`,
          )
          .get(event.run_uuid, event.timestamp, event.type, event.message);
        if (existing) {
          continue;
        }
        operationalDb
          .prepare(
            `INSERT INTO events (run_uuid, repo_id, phase, level, type, message, metadata, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.run_uuid,
            repoId,
            event.phase,
            event.level,
            event.type,
            event.message,
            event.metadata,
            event.timestamp,
          );
      }
    });

    migrateTx();

    const BATCH_SIZE = 500;
    for (let i = 0; i < eventIds.length; i += BATCH_SIZE) {
      const batch = eventIds.slice(i, i + BATCH_SIZE);
      controlPlaneDb
        .prepare(`DELETE FROM events WHERE id IN (${batch.map(() => '?').join(',')})`)
        .run(...batch);
    }
  }

  private async migrateArtifacts(): Promise<void> {
    const { legacyArtifactRoot, operationalArtifactRoot, artifactMover } = this.deps;

    if (!legacyArtifactRoot || !operationalArtifactRoot || !artifactMover) {
      return;
    }

    const sentinelPath = join(legacyArtifactRoot, MIGRATION_SENTINEL);
    try {
      await access(sentinelPath);
      return;
    } catch {
      // Sentinel doesn't exist, proceed with migration
    }

    let artifactsExist = false;
    try {
      const entries = await readdir(legacyArtifactRoot);
      artifactsExist = entries.some((e) => e !== MIGRATION_SENTINEL);
    } catch {
      return;
    }

    if (!artifactsExist) {
      await writeFile(
        sentinelPath,
        JSON.stringify({ migratedAt: new Date().toISOString() }),
        'utf8',
      );
      return;
    }

    try {
      await mkdir(operationalArtifactRoot, { recursive: true });
      const entries = await readdir(legacyArtifactRoot);
      for (const entry of entries) {
        if (entry === MIGRATION_SENTINEL) {
          continue;
        }
        const src = join(legacyArtifactRoot, entry);
        const dest = join(operationalArtifactRoot, entry);
        const statResult = await stat(src);
        if (statResult.isDirectory()) {
          await migrateDirectory(artifactMover, src, dest);
        } else {
          await artifactMover(src, dest);
        }
      }
      await writeFile(
        sentinelPath,
        JSON.stringify({ migratedAt: new Date().toISOString() }),
        'utf8',
      );
    } catch (err) {
      throw new MigrationError(
        `Artifact migration failed: ${err instanceof Error ? err.message : String(err)}`,
        'artifact_migration_failed',
      );
    }
  }
}

async function migrateDirectory(
  mover: (src: string, dest: string) => Promise<void>,
  src: string,
  dest: string,
): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await migrateDirectory(mover, srcPath, destPath);
    } else {
      await mover(srcPath, destPath);
    }
  }
}

export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'no_eligible_repositories'
      | 'ambiguous_ownership'
      | 'repository_mismatch'
      | 'artifact_migration_failed',
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}
