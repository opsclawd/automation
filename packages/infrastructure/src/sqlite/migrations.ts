import type { Db } from './database.js';
import * as init from './migrations/0001-init.js';
import * as addPid from './migrations/0002-add-pid-column.js';
import * as agentInvocations from './migrations/0003-agent-invocations.js';
import * as phaseRename from './migrations/0004-phase-rename.js';

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: init.version, sql: init.sql },
  { version: addPid.version, sql: addPid.sql },
  { version: agentInvocations.version, sql: agentInvocations.sql },
  { version: phaseRename.version, sql: phaseRename.sql },
];

export function applyMigrations(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_version').all() as Array<{ version: number }>).map(
      (r) => r.version,
    ),
  );

  const apply = db.transaction((version: number, sql: string) => {
    db.exec(sql);
    db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      version,
      new Date().toISOString(),
    );
  });

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    apply(m.version, m.sql);
  }
}
