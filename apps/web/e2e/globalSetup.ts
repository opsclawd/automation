import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const DB_PATH = join(REPO_ROOT, '.ai-runs', 'orchestrator.sqlite');
const RUNS_DIR = join(REPO_ROOT, '.ai-runs');

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
];

export default async function globalSetup() {
  const db = new Database(DB_PATH);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO runs (uuid, display_id, issue_number, type, status, current_phase,
      completed_phases, started_at, completed_at, failure_reason, exit_code, duration_ms)
    VALUES (@uuid, @display_id, @issue_number, @type, @status, @current_phase,
      @completed_phases, @started_at, @completed_at, @failure_reason, @exit_code, @duration_ms)
  `);

  for (const run of SEED_RUNS) {
    insert.run(run);

    const runDir = join(RUNS_DIR, run.display_id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'combined.log'), 'seeded log content\n');
  }

  db.close();
}
