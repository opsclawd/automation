import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

const READY_MARKER = 'READY\n';
const ARGV_ERROR = 'ERROR_MISSING_ARGS\n';

interface Args {
  dbPath: string;
  repoId: string;
  workerId: string;
  runId: string;
  cooperative: boolean;
}

function parseArgs(argv: string[]): Args | null {
  if (argv.length < 6) return null;
  return {
    dbPath: argv[2],
    repoId: argv[3],
    workerId: argv[4],
    runId: argv[5],
    cooperative: argv[6] === 'true',
  };
}

function hexToken(): string {
  return randomBytes(16).toString('hex');
}

function applyMinimalSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      local_base_path TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      remote_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_concurrent_runs INTEGER NOT NULL DEFAULT 1,
      config_metadata TEXT NOT NULL DEFAULT '{}',
      health_status TEXT NOT NULL DEFAULT 'healthy',
      health_error TEXT,
      last_health_check_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runs (
      uuid TEXT PRIMARY KEY,
      display_id TEXT NOT NULL UNIQUE,
      repo_id TEXT,
      issue_number INTEGER NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      current_phase TEXT,
      completed_phases TEXT NOT NULL DEFAULT '[]',
      skipped_phases TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      failure_reason TEXT,
      exit_code INTEGER,
      duration_ms INTEGER,
      pid INTEGER,
      start_commit_sha TEXT,
      base_branch TEXT,
      config_fingerprint TEXT,
      config_sources_json TEXT
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_by TEXT,
      claim_token TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      claim_expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL DEFAULT '',
      hostname TEXT NOT NULL,
      process_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worker_leases (
      repo_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      lease_token TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
      repo_id TEXT,
      phase TEXT,
      level TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      timestamp TEXT NOT NULL
    );
  `);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args) {
    process.stdout.write(ARGV_ERROR);
    process.exit(1);
  }

  const { dbPath, repoId, workerId, runId, cooperative } = args;

  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  applyMinimalSchema(db);

  const now = new Date();
  const host = hostname();
  const pid = process.pid;
  const jobId = `job-${runId}-1`;
  const leaseToken = hexToken();
  const claimToken = hexToken();
  const ttlMs = 60_000;
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + ttlMs).toISOString();
  const displayId = `issue-1-${runId.slice(-6)}`;

  const [owner, name] = repoId.split('/');
  db.prepare(
    `
    INSERT INTO repositories (id, full_name, owner, name, local_base_path, default_branch, remote_url, enabled, max_concurrent_runs, config_metadata, health_status, health_error, last_health_check_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'main', ?, 1, 1, '{}', 'healthy', NULL, NULL, ?, ?)
  `,
  ).run(
    repoId,
    repoId,
    owner,
    name,
    `/tmp/repos/${repoId}`,
    `git@github.com:${repoId}.git`,
    nowIso,
    nowIso,
  );

  db.prepare(
    `
    INSERT INTO workers (id, repo_id, hostname, process_id, status, heartbeat_at)
    VALUES (?, ?, ?, ?, 'busy', ?)
  `,
  ).run(workerId, repoId, host, pid, nowIso);

  db.prepare(
    `
    INSERT INTO runs (uuid, display_id, repo_id, issue_number, type, status, completed_phases, skipped_phases, started_at, pid)
    VALUES (?, ?, ?, 1, 'issue_to_pr', 'running', '[]', '[]', ?, ?)
  `,
  ).run(runId, displayId, repoId, nowIso, pid);

  db.prepare(
    `
    INSERT INTO jobs (id, run_id, repo_id, issue_number, status, priority, attempts, claimed_by, claim_token, created_at, claimed_at, started_at, claim_expires_at)
    VALUES (?, ?, ?, 1, 'running', 0, 1, ?, ?, ?, ?, ?, ?)
  `,
  ).run(jobId, runId, repoId, workerId, claimToken, nowIso, nowIso, nowIso, expiresIso);

  db.prepare(
    `
    INSERT INTO worker_leases (repo_id, worker_id, run_id, acquired_at, heartbeat_at, expires_at, lease_token)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(repoId, workerId, runId, nowIso, nowIso, expiresIso, leaseToken);

  // Arm the SIGTERM handling *before* announcing readiness. A bare
  // `process.on('SIGTERM', ...)` registers zero active libuv handles, so without
  // a timer the process would exit immediately once the event loop drains --
  // and if the READY marker were written before this registration, a parent
  // that reacts fast enough could send SIGTERM before any handler exists,
  // falling through to the OS default (immediate death, no cleanup). Both the
  // timer and the listener must be in place first (see #653 shutdown-recovery
  // flake history).
  if (!cooperative) {
    // Swallow SIGTERM to simulate a worker that ignores the shutdown signal;
    // the fenced lease must survive until the grace timer forces a close below.
    process.on('SIGTERM', () => {});

    const nonCooperativeDone = new Promise<void>((resolve) => {
      setTimeout(() => {
        db.close();
        resolve();
      }, 10_000);
    });
    process.stdout.write(READY_MARKER);
    await nonCooperativeDone;
    return;
  }

  let handled = false;
  const fallbackTimer = setTimeout(() => {
    if (!handled) {
      handled = true;
      db.close();
      process.exit(0);
    }
  }, 10_000);

  const cooperativeDone = new Promise<void>((resolve) => {
    process.on('SIGTERM', () => {
      if (handled) return;
      handled = true;
      clearTimeout(fallbackTimer);
      const releaseNow = new Date();
      const releaseNowIso = releaseNow.toISOString();
      db.prepare(
        'DELETE FROM worker_leases WHERE repo_id = ? AND worker_id = ? AND lease_token = ?',
      ).run(repoId, workerId, leaseToken);
      db.prepare("UPDATE jobs SET status = 'cancelled', completed_at = ? WHERE id = ?").run(
        releaseNowIso,
        jobId,
      );
      db.prepare(
        "UPDATE runs SET status = 'cancelled', failure_reason = 'interrupted by SIGTERM', completed_at = ? WHERE uuid = ?",
      ).run(releaseNowIso, runId);
      db.prepare("UPDATE workers SET status = 'idle' WHERE id = ? AND repo_id = ?").run(
        workerId,
        repoId,
      );
      db.close();
      resolve();
      process.exit(0);
    });
  });

  process.stdout.write(READY_MARKER);
  await cooperativeDone;
}

main().catch((err) => {
  console.error('recovery-worker-child error:', err);
  process.exit(1);
});
