import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, applyMigrations } from '../../../packages/infrastructure/src/index.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const TEST_AI_DIR = join(REPO_ROOT, 'test-results', 'e2e');
const DB_PATH = join(TEST_AI_DIR, 'orchestrator-test.sqlite');
const RUNS_DIR = TEST_AI_DIR;

function sha256(val: string): string {
  return createHash('sha256').update(val).digest('hex');
}

const HEALTHY_1_ID = sha256('owner/repo-healthy-1');
const HEALTHY_2_ID = sha256('owner/repo-healthy-2');
const DISABLED_ID = sha256('owner/repo-disabled');
const UNKNOWN_ID = sha256('owner/repo-unknown');
const DEGRADED_ID = sha256('owner/repo-degraded');
const UNREACHABLE_ID = sha256('owner/repo-unreachable');

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
  repo_id: string;
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
    repo_id: HEALTHY_1_ID,
  },
  {
    uuid: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
    display_id: 'R-002',
    issue_number: 1, // Same issue number, distinct repo, distinct UUID & display_id
    type: 'issue_to_pr',
    status: 'running',
    current_phase: null,
    completed_phases: '["implement"]',
    started_at: new Date().toISOString(),
    completed_at: null,
    failure_reason: null,
    exit_code: null,
    duration_ms: 10000,
    repo_id: HEALTHY_2_ID,
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
    repo_id: HEALTHY_1_ID,
  },
];

// Seed 27 more runs (R-004..R-030) so total = 30, triggering pagination (25/page)
const extraUuids = Array.from({ length: 27 }, () => randomUUID());
for (let i = 4; i <= 30; i++) {
  const displayId = `R-${i.toString().padStart(3, '0')}`;
  const isLast = i === 30;
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
    repo_id: isLast ? 'unregistered-repo-id' : HEALTHY_1_ID,
  });
}

export default async function globalSetup() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  mkdirSync(RUNS_DIR, { recursive: true });
  const db = openDatabase(DB_PATH);
  applyMigrations(db);

  db.exec('DELETE FROM failures');
  db.exec('DELETE FROM events');
  db.exec('DELETE FROM artifacts');
  db.exec('DELETE FROM phases');
  db.exec('DELETE FROM runs');
  db.exec('DELETE FROM repositories');

  const insertRepo = db.prepare(`
    INSERT INTO repositories (
      id, full_name, owner, name, local_base_path, default_branch, remote_url,
      enabled, health_status, health_error, last_health_check_at, created_at, updated_at
    ) VALUES (
      @id, @full_name, @owner, @name, @local_base_path, @default_branch, @remote_url,
      @enabled, @health_status, @health_error, @last_health_check_at, @created_at, @updated_at
    )
  `);

  const reposData = [
    {
      id: HEALTHY_1_ID,
      full_name: 'owner/repo-healthy-1',
      owner: 'owner',
      name: 'repo-healthy-1',
      local_base_path: '/path/to/repo-healthy-1',
      default_branch: 'main',
      remote_url: 'git@github.com:owner/repo-healthy-1.git',
      enabled: 1,
      health_status: 'healthy',
      health_error: null,
      last_health_check_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: HEALTHY_2_ID,
      full_name: 'owner/repo-healthy-2',
      owner: 'owner',
      name: 'repo-healthy-2',
      local_base_path: '/path/to/repo-healthy-2',
      default_branch: 'main',
      remote_url: 'git@github.com:owner/repo-healthy-2.git',
      enabled: 1,
      health_status: 'healthy',
      health_error: null,
      last_health_check_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: DISABLED_ID,
      full_name: 'owner/repo-disabled',
      owner: 'owner',
      name: 'repo-disabled',
      local_base_path: '/path/to/repo-disabled',
      default_branch: 'main',
      remote_url: 'git@github.com:owner/repo-disabled.git',
      enabled: 0,
      health_status: 'healthy',
      health_error: null,
      last_health_check_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: UNKNOWN_ID,
      full_name: 'owner/repo-unknown',
      owner: 'owner',
      name: 'repo-unknown',
      local_base_path: '/path/to/repo-unknown',
      default_branch: 'main',
      remote_url: 'git@github.com:owner/repo-unknown.git',
      enabled: 1,
      health_status: 'unknown',
      health_error: null,
      last_health_check_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: DEGRADED_ID,
      full_name: 'owner/repo-degraded',
      owner: 'owner',
      name: 'repo-degraded',
      local_base_path: '/path/to/repo-degraded',
      default_branch: 'main',
      remote_url: 'git@github.com:owner/repo-degraded.git',
      enabled: 1,
      health_status: 'degraded',
      health_error: 'health check failed',
      last_health_check_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: UNREACHABLE_ID,
      full_name: 'owner/repo-unreachable',
      owner: 'owner',
      name: 'repo-unreachable',
      local_base_path: '/path/to/repo-unreachable',
      default_branch: 'main',
      remote_url: 'git@github.com:owner/repo-unreachable.git',
      enabled: 1,
      health_status: 'unreachable',
      health_error: 'unreachable',
      last_health_check_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];

  for (const r of reposData) {
    insertRepo.run(r);
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO runs (uuid, display_id, issue_number, type, status, current_phase,
      completed_phases, started_at, completed_at, failure_reason, exit_code, duration_ms, repo_id)
    VALUES (@uuid, @display_id, @issue_number, @type, @status, @current_phase,
      @completed_phases, @started_at, @completed_at, @failure_reason, @exit_code, @duration_ms, @repo_id)
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
    run_uuid: SEED_RUNS[2].uuid,
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

  const insertEvent = db.prepare(`
    INSERT INTO events (run_uuid, phase, level, type, message, metadata, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const now = new Date();
  const ts = (offsetMs: number) => new Date(now.getTime() - offsetMs).toISOString();

  const r001 = SEED_RUNS[0].uuid;
  insertEvent.run(r001, 'read_issue', 'info', 'phase.started', '', '{}', ts(120_000));
  insertEvent.run(r001, 'read_issue', 'info', 'phase.completed', '', '{}', ts(115_000));
  insertEvent.run(r001, 'plan-design', 'info', 'phase.started', '', '{}', ts(115_000));
  insertEvent.run(r001, 'plan-design', 'info', 'phase.completed', '', '{}', ts(110_000));
  insertEvent.run(r001, 'plan-write', 'info', 'phase.started', '', '{}', ts(110_000));
  insertEvent.run(r001, 'plan-write', 'info', 'phase.completed', '', '{}', ts(100_000));
  insertEvent.run(r001, 'implement', 'info', 'phase.started', '', '{}', ts(100_000));

  const r003 = SEED_RUNS[2].uuid;
  insertEvent.run(r003, 'read_issue', 'info', 'phase.started', '', '{}', ts(180_000));
  insertEvent.run(r003, 'read_issue', 'info', 'phase.completed', '', '{}', ts(175_000));
  insertEvent.run(r003, 'plan-design', 'info', 'phase.started', '', '{}', ts(175_000));
  insertEvent.run(r003, 'plan-design', 'info', 'phase.completed', '', '{}', ts(170_000));
  insertEvent.run(r003, 'plan-write', 'info', 'phase.started', '', '{}', ts(170_000));
  insertEvent.run(r003, 'plan-write', 'info', 'phase.completed', '', '{}', ts(160_000));
  insertEvent.run(r003, 'implement', 'info', 'phase.started', '', '{}', ts(160_000));
  insertEvent.run(r003, 'implement', 'info', 'phase.completed', '', '{}', ts(150_000));
  insertEvent.run(r003, 'validate', 'info', 'phase.started', '', '{}', ts(150_000));
  insertEvent.run(
    r003,
    'validate',
    'error',
    'phase.failed',
    'something went wrong',
    '{"command":"pnpm build","exitCode":1}',
    ts(140_000),
  );

  db.close();
}
