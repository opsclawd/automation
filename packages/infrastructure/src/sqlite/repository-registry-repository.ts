import type { Db } from './database.js';
import type { RepositoryRegistryPort, RepositoryUpdatePatch } from '@ai-sdlc/application/ports';
import {
  DuplicateRepositoryError,
  RepositoryHasActiveRunsError,
  RepositoryNotFoundError,
  type Repository,
} from '@ai-sdlc/domain';

const TERMINAL_STATUSES = "('passed','failed','cancelled')";

export class RepositoryRegistryRepository implements RepositoryRegistryPort {
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

  private findRow(id: string): { id: string } | undefined {
    return this.db.prepare(`SELECT id FROM repositories WHERE id = ?`).get(id) as
      | { id: string }
      | undefined;
  }
}
