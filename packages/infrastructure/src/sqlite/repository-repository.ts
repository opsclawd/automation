import { RepositoryId, type Repository } from '@ai-sdlc/domain';
import type { RepositoryPort } from '@ai-sdlc/application/ports';
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
  created_at: string;
  updated_at: string;
}

export class SqliteRepositoryRepository implements RepositoryPort {
  constructor(private readonly db: Db) {}

  findById(id: RepositoryId): Repository | undefined {
    const row = this.db
      .prepare('SELECT * FROM repositories WHERE id = ?')
      .get(id) as RepositoryRow | undefined;
    return row ? toDomain(row) : undefined;
  }

  findByFullName(fullName: string): Repository | undefined {
    const row = this.db
      .prepare('SELECT * FROM repositories WHERE full_name = ?')
      .get(fullName) as RepositoryRow | undefined;
    return row ? toDomain(row) : undefined;
  }

  listEnabled(): Repository[] {
    const rows = this.db
      .prepare('SELECT * FROM repositories WHERE enabled = 1')
      .all() as RepositoryRow[];
    return rows.map(toDomain);
  }

  list(): Repository[] {
    const rows = this.db.prepare('SELECT * FROM repositories').all() as RepositoryRow[];
    return rows.map(toDomain);
  }

  upsert(repo: Repository): void {
    this.db
      .prepare(
        `INSERT INTO repositories (id, owner, name, full_name, default_branch, local_base_path, enabled, max_concurrent_runs, created_at, updated_at)
         VALUES (@id, @owner, @name, @full_name, @default_branch, @local_base_path, @enabled, @max_concurrent_runs, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           owner = excluded.owner,
           name = excluded.name,
           full_name = excluded.full_name,
           default_branch = excluded.default_branch,
           local_base_path = excluded.local_base_path,
           enabled = excluded.enabled,
           max_concurrent_runs = excluded.max_concurrent_runs,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: repo.id,
        owner: repo.owner,
        name: repo.name,
        full_name: repo.fullName,
        default_branch: repo.defaultBranch,
        local_base_path: repo.localBasePath,
        enabled: repo.enabled ? 1 : 0,
        max_concurrent_runs: repo.maxConcurrentRuns,
        created_at: repo.createdAt.toISOString(),
        updated_at: repo.updatedAt.toISOString(),
      });
  }
}

function toDomain(row: RepositoryRow): Repository {
  return {
    id: RepositoryId(row.id),
    owner: row.owner,
    name: row.name,
    fullName: row.full_name,
    defaultBranch: row.default_branch,
    localBasePath: row.local_base_path,
    enabled: row.enabled === 1,
    maxConcurrentRuns: row.max_concurrent_runs as 1,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
