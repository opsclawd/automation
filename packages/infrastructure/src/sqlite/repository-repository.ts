import {
  type Repository,
  type RepositoryId,
  type RepositoryHealthStatus,
  RepositoryId as mkRepositoryId,
} from '@ai-sdlc/domain';
import type { RepositoryRegistryPort } from '@ai-sdlc/application';
import type { Db } from './database.js';

interface RepositoryRow {
  id: string;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string;
  local_base_path: string;
  enabled: number;
  max_concurrent_runs: number;
  config_metadata: string;
  created_at: string;
  updated_at: string;
  last_health_check_at: string | null;
  health_status: string;
  health_error: string | null;
}

function toRepository(row: RepositoryRow): Repository {
  return {
    id: mkRepositoryId(row.id),
    owner: row.owner,
    name: row.name,
    fullName: row.full_name,
    defaultBranch: row.default_branch,
    localBasePath: row.local_base_path,
    enabled: Boolean(row.enabled),
    maxConcurrentRuns: row.max_concurrent_runs as 1,
    configMetadata: JSON.parse(row.config_metadata) as Record<string, unknown>,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    ...(row.last_health_check_at ? { lastHealthCheckAt: new Date(row.last_health_check_at) } : {}),
    healthStatus: row.health_status as RepositoryHealthStatus,
    ...(row.health_error ? { healthError: row.health_error } : {}),
  };
}

export class RepositoryRepository implements RepositoryRegistryPort {
  constructor(private readonly db: Db) {}

  save(r: Repository): void {
    this.db
      .prepare(
        `INSERT INTO repositories (
          id, owner, name, full_name, default_branch, local_base_path,
          enabled, max_concurrent_runs, config_metadata,
          created_at, updated_at, last_health_check_at, health_status, health_error
        ) VALUES (
          @id, @owner, @name, @full_name, @default_branch, @local_base_path,
          @enabled, @max_concurrent_runs, @config_metadata,
          @created_at, @updated_at, @last_health_check_at, @health_status, @health_error
        ) ON CONFLICT(id) DO UPDATE SET
          owner = excluded.owner,
          name = excluded.name,
          full_name = excluded.full_name,
          default_branch = excluded.default_branch,
          local_base_path = excluded.local_base_path,
          enabled = excluded.enabled,
          max_concurrent_runs = excluded.max_concurrent_runs,
          config_metadata = excluded.config_metadata,
          updated_at = excluded.updated_at,
          last_health_check_at = excluded.last_health_check_at,
          health_status = excluded.health_status,
          health_error = excluded.health_error`,
      )
      .run({
        id: r.id,
        owner: r.owner,
        name: r.name,
        full_name: r.fullName,
        default_branch: r.defaultBranch,
        local_base_path: r.localBasePath,
        enabled: r.enabled ? 1 : 0,
        max_concurrent_runs: r.maxConcurrentRuns,
        config_metadata: JSON.stringify(r.configMetadata),
        created_at: r.createdAt.toISOString(),
        updated_at: r.updatedAt.toISOString(),
        last_health_check_at: r.lastHealthCheckAt?.toISOString() ?? null,
        health_status: r.healthStatus,
        health_error: r.healthError ?? null,
      });
  }

  delete(id: RepositoryId): void {
    this.db.prepare('DELETE FROM repositories WHERE id = ?').run(id);
  }

  findById(id: RepositoryId): Repository | undefined {
    const row = this.db.prepare('SELECT * FROM repositories WHERE id = ?').get(id) as
      | RepositoryRow
      | undefined;
    return row ? toRepository(row) : undefined;
  }

  findByFullName(fullName: string): Repository | undefined {
    const row = this.db.prepare('SELECT * FROM repositories WHERE full_name = ?').get(fullName) as
      | RepositoryRow
      | undefined;
    return row ? toRepository(row) : undefined;
  }

  findByLocalPath(localPath: string): Repository | undefined {
    const row = this.db
      .prepare('SELECT * FROM repositories WHERE local_base_path = ?')
      .get(localPath) as RepositoryRow | undefined;
    return row ? toRepository(row) : undefined;
  }

  listEnabled(): Repository[] {
    const rows = this.db.prepare('SELECT * FROM repositories WHERE enabled = 1').all() as RepositoryRow[];
    return rows.map(toRepository);
  }

  listAll(): Repository[] {
    const rows = this.db.prepare('SELECT * FROM repositories').all() as RepositoryRow[];
    return rows.map(toRepository);
  }
}
