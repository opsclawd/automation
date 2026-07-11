import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

const SYNTHETIC_FULL_NAME = 'unknown/unknown';

function repositoryId(fullName: string): string {
  return createHash('sha256').update(fullName).digest('hex');
}

export const up = async (db: Database.Database): Promise<void> => {
  const repoCount = db.prepare(`SELECT COUNT(*) as c FROM repositories`).get() as { c: number };
  if (repoCount.c === 0) {
    const syntheticId = repositoryId(SYNTHETIC_FULL_NAME);
    db.prepare(
      `INSERT OR IGNORE INTO repositories (id, full_name, owner, name, local_base_path, default_branch, remote_url, enabled, health_status, created_at, updated_at)
       VALUES (?, ?, 'unknown', 'unknown', '/unknown/unknown', 'main', '', 1, 'unknown', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    ).run(syntheticId, SYNTHETIC_FULL_NAME);
  }

  db.prepare(
    `UPDATE runs
     SET repo_id = (SELECT id FROM repositories ORDER BY created_at ASC LIMIT 1)
     WHERE repo_id IS NULL OR repo_id = '' OR repo_id = 'unknown'`,
  ).run();

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_runs_repo_id_issue_number ON runs(repo_id, issue_number);`,
  );
};
