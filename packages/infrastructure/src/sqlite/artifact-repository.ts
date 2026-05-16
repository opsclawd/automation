import type { Artifact } from '@ai-sdlc/domain';
import type { Db } from './database.js';

export class ArtifactRepository {
  constructor(private readonly db: Db) {}

  insert(artifact: Artifact): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, run_uuid, phase, type, path, created_at)
         VALUES (@id, @run_uuid, @phase, @type, @path, @created_at)`,
      )
      .run({
        id: artifact.id,
        run_uuid: artifact.runUuid,
        phase: artifact.phase ?? null,
        type: artifact.type,
        path: artifact.path,
        created_at: artifact.createdAt.toISOString(),
      });
  }

  listByRun(runUuid: string): Artifact[] {
    return (
      this.db
        .prepare('SELECT * FROM artifacts WHERE run_uuid = ? ORDER BY created_at ASC')
        .all(runUuid) as Array<{
        id: string;
        run_uuid: string;
        phase: string | null;
        type: string;
        path: string;
        created_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      runUuid: r.run_uuid,
      ...(r.phase !== null ? { phase: r.phase } : {}),
      type: r.type as Artifact['type'],
      path: r.path,
      createdAt: new Date(r.created_at),
    }));
  }
}
