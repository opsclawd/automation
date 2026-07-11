import type { Db } from './database.js';
import type {
  RepositoryRegistryPort,
  RepositoryUpdatePatch,
  RepositoryPort,
} from '@ai-sdlc/application/ports';
import {
  DuplicateRepositoryError,
  RepositoryHasActiveRunsError,
  RepositoryNotFoundError,
  type Repository,
  RepositoryId,
  type RepositoryHealthStatus,
} from '@ai-sdlc/domain';

interface RepositoryRow {
  id: string;
  full_name: string;
  owner: string;
  name: string;
  local_base_path: string;
  default_branch: string;
  remote_url: string;
  enabled: number;
  max_concurrent_runs: number;
  config_metadata: string;
  health_status: string;
  health_error: string | null;
  last_health_check_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRepository(row: RepositoryRow): Repository {
  return {
    id: RepositoryId(row.id),
    fullName: row.full_name,
    owner: row.owner,
    name: row.name,
    localBasePath: row.local_base_path,
    defaultBranch: row.default_branch,
    remoteUrl: row.remote_url,
    enabled: row.enabled === 1,
    maxConcurrentRuns: row.max_concurrent_runs as 1,
    configMetadata: row.config_metadata,
    healthStatus: row.health_status as RepositoryHealthStatus,
    healthError: row.health_error,
    lastHealthCheckAt: row.last_health_check_at ? new Date(row.last_health_check_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

const TERMINAL_STATUSES = "('passed','failed','cancelled')";

export class RepositoryRegistryRepository implements RepositoryRegistryPort, RepositoryPort {
  constructor(private readonly db: Db) {}

  insert(repo: Repository): void {
    try {
      this.db
        .prepare(
          `INSERT INTO repositories (id, full_name, owner, name, local_base_path, default_branch,
             remote_url, enabled, max_concurrent_runs, config_metadata, health_status, health_error,
             last_health_check_at, created_at, updated_at)
           VALUES (@id, @full_name, @owner, @name, @local_base_path, @default_branch,
             @remote_url, @enabled, @max_concurrent_runs, @config_metadata, @health_status,
             @health_error, @last_health_check_at, @created_at, @updated_at)`,
        )
        .run({
          id: repo.id,
          full_name: repo.fullName,
          owner: repo.owner,
          name: repo.name,
          local_base_path: repo.localBasePath,
          default_branch: repo.defaultBranch,
          remote_url: repo.remoteUrl,
          enabled: repo.enabled ? 1 : 0,
          max_concurrent_runs: repo.maxConcurrentRuns,
          config_metadata: repo.configMetadata,
          health_status: repo.healthStatus,
          health_error: repo.healthError,
          last_health_check_at: repo.lastHealthCheckAt?.toISOString() ?? null,
          created_at: repo.createdAt.toISOString(),
          updated_at: repo.updatedAt.toISOString(),
        });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE constraint failed: repositories\.full_name/.test(msg)) {
        throw new DuplicateRepositoryError({ fullName: repo.fullName });
      }
      if (/UNIQUE constraint failed: repositories\.local_base_path/.test(msg)) {
        throw new DuplicateRepositoryError({ localBasePath: repo.localBasePath });
      }
      throw err;
    }
  }

  update(id: Repository['id'], patch: RepositoryUpdatePatch, now: Date): void {
    const existing = this.findRow(id);
    if (!existing) throw new RepositoryNotFoundError(id);

    const fields: string[] = [];
    const params: Record<string, unknown> = { id, updated_at: now.toISOString() };

    if (patch.defaultBranch !== undefined) {
      fields.push('default_branch = @default_branch');
      params.default_branch = patch.defaultBranch;
    }
    if (patch.remoteUrl !== undefined) {
      fields.push('remote_url = @remote_url');
      params.remote_url = patch.remoteUrl;
    }
    if (patch.enabled !== undefined) {
      fields.push('enabled = @enabled');
      params.enabled = patch.enabled ? 1 : 0;
    }
    if (patch.configMetadata !== undefined) {
      fields.push('config_metadata = @config_metadata');
      params.config_metadata = patch.configMetadata;
    }
    if (patch.healthStatus !== undefined) {
      fields.push('health_status = @health_status');
      params.health_status = patch.healthStatus;
    }
    if (patch.healthError !== undefined) {
      fields.push('health_error = @health_error');
      params.health_error = patch.healthError;
    }
    if (patch.lastHealthCheckAt !== undefined) {
      fields.push('last_health_check_at = @last_health_check_at');
      params.last_health_check_at = patch.lastHealthCheckAt?.toISOString() ?? null;
    }
    fields.push('updated_at = @updated_at');

    this.db.prepare(`UPDATE repositories SET ${fields.join(', ')} WHERE id = @id`).run(params);
  }

  remove(id: Repository['id']): void {
    const active = this.findActiveRunCount(id);
    if (active > 0) throw new RepositoryHasActiveRunsError(id, active);
    const result = this.db.prepare(`DELETE FROM repositories WHERE id = ?`).run(id);
    if (result.changes === 0) throw new RepositoryNotFoundError(id);
  }

  findActiveRunCount(id: Repository['id']): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM runs WHERE repo_id = ? AND status NOT IN ${TERMINAL_STATUSES}`,
      )
      .get(id) as { c: number };
    return row.c;
  }

  findById(id: Repository['id']): Repository | undefined {
    const row = this.db.prepare(`SELECT * FROM repositories WHERE id = ?`).get(id) as
      | RepositoryRow
      | undefined;
    return row ? rowToRepository(row) : undefined;
  }

  findByFullName(fullName: string): Repository | undefined {
    const row = this.db.prepare(`SELECT * FROM repositories WHERE full_name = ?`).get(fullName) as
      | RepositoryRow
      | undefined;
    return row ? rowToRepository(row) : undefined;
  }

  findByLocalPath(localBasePath: string): Repository | undefined {
    const row = this.db
      .prepare(`SELECT * FROM repositories WHERE local_base_path = ?`)
      .get(localBasePath) as RepositoryRow | undefined;
    return row ? rowToRepository(row) : undefined;
  }

  listAll(): Repository[] {
    const rows = this.db
      .prepare(`SELECT * FROM repositories ORDER BY created_at ASC`)
      .all() as RepositoryRow[];
    return rows.map(rowToRepository);
  }

  listEnabled(): Repository[] {
    const rows = this.db
      .prepare(`SELECT * FROM repositories WHERE enabled = 1 ORDER BY created_at ASC`)
      .all() as RepositoryRow[];
    return rows.map(rowToRepository);
  }

  private findRow(id: string): { id: string } | undefined {
    return this.db.prepare(`SELECT id FROM repositories WHERE id = ?`).get(id) as
      | { id: string }
      | undefined;
  }
}
