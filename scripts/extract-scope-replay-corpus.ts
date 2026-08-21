#!/usr/bin/env tsx
/**
 * extract-scope-replay-corpus.ts — Extract boundary-halt replay corpus static fixtures.
 *
 * Pulls boundary failure records for the six recorded boundary-halt runs:
 *   - 09f73f6f-eede-42fe-aaf4-694abc8ab686 (issue 62, comfy-content-orchestrator)
 *   - e0c4dd03-da65-4a26-97dd-5a2a6e52520c (issue 63, comfy-content-orchestrator)
 *   - ff2e91bc-eb8b-4eff-91c6-5b067f5d1e04 (issue 920, automation)
 *   - 8ec8d952-21cc-423a-b8bf-025db1e2c7b2 (issue 921, automation)
 *   - 5dc78eb1-157a-4118-8894-631df496d448 (issue 944, automation)
 *   - 891a6fec-47b3-46b4-8983-cc954eabda6d (issue 951, automation)
 *
 * Parses violating paths out of failure messages and outputs structured
 * JSON fixtures containing runId, issueNumber, repo, path, taskManifest,
 * failureKind, rawMessage, label, and rationale.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';

export interface ScopeReplayFixtureEntry {
  runId: string;
  issueNumber: number;
  repo: string;
  path: string;
  taskManifest: Record<string, unknown> | null;
  failureKind: string;
  rawMessage: string;
  label: 'false_positive' | 'true_positive' | null;
  rationale: string | null;
}

export interface FailureRecord {
  run_uuid: string;
  issue_number: number;
  repo: string;
  phase: string;
  kind: string;
  message: string;
  can_retry: number;
}

export function parseViolatingPathsFromMessage(message: string): string[] {
  const paths: string[] = [];

  // Pattern 1: "committed undeclared files: file1, file2"
  const undeclaredMatch = message.match(/committed undeclared files:\s*([^]+)$/i);
  if (undeclaredMatch?.[1]) {
    const listStr = undeclaredMatch[1].replace(/\.\s*$/, '');
    const items = listStr.split(',').map((s) => s.trim()).filter(Boolean);
    paths.push(...items);
    return paths;
  }

  // Pattern 2: "modified reference_files: file1, file2"
  const refMatch = message.match(/modified reference_files:\s*([^]+)$/i);
  if (refMatch?.[1]) {
    const listStr = refMatch[1].replace(/\.\s*$/, '');
    const items = listStr.split(',').map((s) => s.trim()).filter(Boolean);
    paths.push(...items);
    return paths;
  }

  // Pattern 3: "plan-review left the worktree dirty: file1, file2, ... and N more."
  const dirtyMatch = message.match(/left the worktree dirty:\s*([^]+)$/i);
  if (dirtyMatch?.[1]) {
    let listStr = dirtyMatch[1].trim();
    // Trim trailing "and N more." or trailing period
    listStr = listStr.replace(/and \d+ more\.\s*$/i, '').replace(/\.\s*$/, '').trim();
    const items = listStr.split(',').map((s) => s.trim()).filter(Boolean);
    paths.push(...items);
    return paths;
  }

  return paths;
}

function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function fetchFailureRecordsFromDb(dbPath: string, runIds: string[]): FailureRecord[] {
  if (!existsSync(dbPath)) {
    return [];
  }
  const db = new Database(dbPath, { readonly: true });
  const placeholders = runIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
         f.run_uuid,
         r.issue_number,
         r.repo,
         f.phase,
         f.kind,
         f.message,
         f.can_retry
       FROM failures f
       LEFT JOIN runs r ON f.run_uuid = r.uuid
       WHERE f.run_uuid IN (${placeholders})
       ORDER BY f.run_uuid, f.created_at ASC`,
    )
    .all(...runIds) as FailureRecord[];
  db.close();
  return rows;
}

function main(): void {
  const repoRoot = findRepoRoot();
  const fixturePath = join(repoRoot, 'packages/application/src/__fixtures__/scope-replay-corpus.json');

  let dbPath = process.env.AI_SDLC_DB_PATH || join(repoRoot, '.ai-runs/orchestrator.sqlite');
  const dbArgIdx = process.argv.indexOf('--db');
  if (dbArgIdx !== -1 && process.argv[dbArgIdx + 1]) {
    dbPath = process.argv[dbArgIdx + 1]!;
  }

  const runIds = [
    '09f73f6f-eede-42fe-aaf4-694abc8ab686',
    'e0c4dd03-da65-4a26-97dd-5a2a6e52520c',
    'ff2e91bc-eb8b-4eff-91c6-5b067f5d1e04',
    '8ec8d952-21cc-423a-b8bf-025db1e2c7b2',
    '5dc78eb1-157a-4118-8894-631df496d448',
    '891a6fec-47b3-46b4-8983-cc954eabda6d',
  ];

  let entries: ScopeReplayFixtureEntry[] = [];

  if (existsSync(dbPath)) {
    console.warn(`Extracting failure records from SQLite DB at ${dbPath}...`);
    const records = fetchFailureRecordsFromDb(dbPath, runIds);
    for (const rec of records) {
      const paths = parseViolatingPathsFromMessage(rec.message);
      for (const p of paths) {
        entries.push({
          runId: rec.run_uuid,
          issueNumber: rec.issue_number,
          repo: rec.repo,
          path: p,
          taskManifest: null,
          failureKind: rec.kind,
          rawMessage: rec.message,
          label: null,
          rationale: null,
        });
      }
    }
  } else if (existsSync(fixturePath)) {
    console.warn(`Reading existing static fixture corpus at ${fixturePath}...`);
    entries = JSON.parse(readFileSync(fixturePath, 'utf8')) as ScopeReplayFixtureEntry[];
  } else {
    console.error(`Neither SQLite DB (${dbPath}) nor fixture file (${fixturePath}) exists.`);
    process.exit(1);
  }

  console.warn(`Total violating path fixture entries: ${entries.length}`);

  if (process.argv.includes('--write') || !existsSync(fixturePath)) {
    writeFileSync(fixturePath, JSON.stringify(entries, null, 2) + '\n', 'utf8');
    console.warn(`Wrote fixture corpus to ${fixturePath}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('extract-scope-replay-corpus.ts')) {
  main();
}
