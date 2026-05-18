import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const TEST_AI_DIR = join(REPO_ROOT, 'test-results', 'e2e');
const DB_PATH = join(TEST_AI_DIR, 'orchestrator-test.sqlite');
const RUNS_DIR = TEST_AI_DIR;

const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  uuid TEXT PRIMARY KEY,
  display_id TEXT NOT NULL UNIQUE,
  issue_number INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  current_phase TEXT,
  completed_phases TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  failure_reason TEXT,
  exit_code INTEGER,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runs_issue_status ON runs (issue_number, status);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC);
CREATE TABLE IF NOT EXISTS phases (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_phases_run ON phases (run_uuid, name);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase TEXT,
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run_ts ON events (run_uuid, timestamp);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase TEXT,
  type TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts (run_uuid);
CREATE TABLE IF NOT EXISTS failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  phase TEXT,
  step TEXT,
  attempt INTEGER,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  exit_code INTEGER,
  can_retry INTEGER NOT NULL,
  suggested_action TEXT NOT NULL,
  artifacts TEXT NOT NULL DEFAULT '[]',
  detected_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_failures_run ON failures (run_uuid);
INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, '1970-01-01T00:00:00.000Z');
`;

interface SeedRun {
  uuid: string;
  display_id: string;
  issue_number: number;
  type: string;
  status: string;
  current_phase: string | null;
  completed_phases: string;
  started_at: string;
  completed_at: string | null;
  failure_reason: string | null;
  exit_code: number | null;
  duration_ms: number | null;
}

// R-001: used by LiveLogViewer tests (needs 'running' + combined.log only)
// R-003: used by tabs + artifact viewer tests (needs failure + extra artifacts)
const SEED_RUNS: SeedRun[] = [
  {
    uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    display_id: 'R-001',
    issue_number: 1,
    type: 'issue_to_pr',
    status: 'running',
    current_phase: 'implement',
    completed_phases: '[]',
    started_at: new Date().toISOString(),
    completed_at: null,
    failure_reason: null,
    exit_code: null,
    duration_ms: 5000,
  },
  {
    uuid: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    display_id: 'R-002',
    issue_number: 2,
    type: 'issue_to_pr',
    status: 'running',
    current_phase: null,
    completed_phases: '["implement"]',
    started_at: new Date().toISOString(),
    completed_at: null,
    failure_reason: null,
    exit_code: null,
    duration_ms: 10000,
  },
  {
    uuid: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
    display_id: 'R-003',
    issue_number: 3,
    type: 'issue_to_pr',
    status: 'failed',
    current_phase: null,
    completed_phases: '["implement"]',
    started_at: new Date(Date.now() - 120_000).toISOString(),
    completed_at: new Date().toISOString(),
    failure_reason: null,
    exit_code: 1,
    duration_ms: 30000,
  },
];

// Seed 27 more runs (R-004..R-030) so total = 30, triggering pagination (25/page)
const extraUuids = Array.from({ length: 27 }, () => randomUUID());
for (let i = 4; i <= 30; i++) {
  const displayId = `R-${i.toString().padStart(3, '0')}`;
  SEED_RUNS.push({
    uuid: extraUuids[i - 4]!,
    display_id: displayId,
    issue_number: i,
    type: 'issue_to_pr',
    status: 'passed',
    current_phase: null,
    completed_phases: '["implement","verify"]',
    started_at: new Date(Date.now() - i * 60_000).toISOString(),
    completed_at: new Date().toISOString(),
    failure_reason: null,
    exit_code: 0,
    duration_ms: 5000,
  });
}

export default async function globalSetup() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  mkdirSync(RUNS_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION_SQL);

  db.exec('DELETE FROM failures');
  db.exec('DELETE FROM runs');

  const insert = db.prepare(`
    INSERT OR REPLACE INTO runs (uuid, display_id, issue_number, type, status, current_phase,
      completed_phases, started_at, completed_at, failure_reason, exit_code, duration_ms)
    VALUES (@uuid, @display_id, @issue_number, @type, @status, @current_phase,
      @completed_phases, @started_at, @completed_at, @failure_reason, @exit_code, @duration_ms)
  `);

  const insertFailure = db.prepare(`
    INSERT OR REPLACE INTO failures (run_uuid, phase, step, attempt, kind, message, exit_code,
      can_retry, suggested_action, artifacts, detected_at)
    VALUES (@run_uuid, @phase, @step, @attempt, @kind, @message, @exit_code,
      @can_retry, @suggested_action, @artifacts, @detected_at)
  `);

  for (const run of SEED_RUNS) {
    insert.run(run);

    const runDir = join(RUNS_DIR, run.display_id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'combined.log'), 'seeded log content\n');
  }

  // Extra artifact files for R-003 (used by tabs + artifact viewer tests)
  const r3Dir = join(RUNS_DIR, 'R-003');
  writeFileSync(join(r3Dir, 'output.json'), JSON.stringify({ key: 'value', count: 42 }));
  writeFileSync(join(r3Dir, 'README.md'), '# Hello\n\nThis is **bold** markdown.');
  writeFileSync(join(r3Dir, 'data.json'), JSON.stringify({ key: 'value', count: 42 }));

  // Failure record for R-003
  insertFailure.run({
    run_uuid: 'c3d4e5f6-a7b8-9012-cdef-123456789012',
    phase: 'implement',
    step: null,
    attempt: 1,
    kind: 'command_failed',
    message: 'something went wrong',
    exit_code: 1,
    can_retry: 0,
    suggested_action: 'fix the test',
    artifacts: JSON.stringify(['test.log']),
    detected_at: new Date().toISOString(),
  });

  db.close();
}
