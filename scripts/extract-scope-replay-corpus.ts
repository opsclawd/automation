#!/usr/bin/env tsx

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

export type SourceDb = 'automation' | 'comfy-content-orchestrator';

export interface ScopeReplayFixtureEntry {
  runId: string;
  issueNumber: number;
  repo: string;
  sourceDb: SourceDb;
  failureId: number;
  phase: string;
  failureKind: string;
  detectedAt: string;
  rawMessage: string;
  rawMessageSha256: string;
  path: string | null;
  pathSource:
    | 'undeclared_files'
    | 'reference_files'
    | 'worktree_dirty'
    | 'oscillation'
    | 'git_failed'
    | 'none';
  recoverable: boolean;
  truncatedCount: number | null;
  label: 'pending_human_review';
  rationale: null;
  taskManifest: null;
}

export interface FailureRow {
  id: number;
  run_uuid: string;
  issue_number: number;
  repo_full_name: string;
  phase: string;
  kind: string;
  message: string;
  detected_at: string;
}

interface ParsedPath {
  path: string;
  source: ScopeReplayFixtureEntry['pathSource'];
}

interface TruncationInfo {
  recoverable: boolean;
  truncatedCount: number | null;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function parsePathsFromMessage(message: string): {
  parsed: ParsedPath[];
  truncation: TruncationInfo;
} {
  const parsed: ParsedPath[] = [];

  const undeclared = message.match(/committed undeclared files:\s*([\s\S]+)$/i);
  if (undeclared?.[1]) {
    const listText = cutAtSentenceBoundary(undeclared[1]);
    for (const item of splitPaths(listText)) {
      parsed.push({ path: item, source: 'undeclared_files' });
    }
    return { parsed, truncation: { recoverable: true, truncatedCount: null } };
  }

  const refFiles = message.match(/modified reference_files\s+([\s\S]+)$/i);
  if (refFiles?.[1]) {
    const listText = cutAtSentenceBoundary(refFiles[1]);
    for (const item of splitPaths(listText)) {
      parsed.push({ path: item, source: 'reference_files' });
    }
    return { parsed, truncation: { recoverable: true, truncatedCount: null } };
  }

  const dirtyMatch = message.match(/left the worktree dirty:\s*([\s\S]+)$/i);
  if (dirtyMatch?.[1]) {
    let raw = dirtyMatch[1];
    const moreMatch = raw.match(/and\s+(\d+)\s+more\b/i);
    const truncatedCount = moreMatch?.[1] ? Number.parseInt(moreMatch[1], 10) : null;
    if (truncatedCount !== null) {
      raw = raw.replace(/,?\s*and\s+\d+\s+more[\s\S]*$/i, '');
    }
    raw = cutAtSentenceBoundary(raw);
    for (const item of splitPaths(raw)) {
      parsed.push({ path: item, source: 'worktree_dirty' });
    }
    return {
      parsed,
      truncation: {
        recoverable: truncatedCount === null,
        truncatedCount,
      },
    };
  }

  const oscMatch = message.match(/File content oscillation detected for\s+(\S+)/i);
  if (oscMatch?.[1]) {
    const cleaned = cleanPathToken(oscMatch[1]);
    if (cleaned) parsed.push({ path: cleaned, source: 'oscillation' });
    return { parsed, truncation: { recoverable: true, truncatedCount: null } };
  }

  const gitMatch = message.match(/PR creation blocked by uncommitted source changes:\s*(\S+)/i);
  if (gitMatch?.[1]) {
    const cleaned = cleanPathToken(gitMatch[1]);
    if (cleaned) parsed.push({ path: cleaned, source: 'git_failed' });
    return { parsed, truncation: { recoverable: true, truncatedCount: null } };
  }

  return { parsed, truncation: { recoverable: false, truncatedCount: null } };
}

function cutAtSentenceBoundary(text: string): string {
  const idx = text.search(/\.\s/);
  return idx === -1 ? text : text.slice(0, idx);
}

function cleanPathToken(raw: string): string | null {
  const trimmed = raw.replace(/^["'`]+|["'`:;,]+$/g, '');
  return /^[A-Za-z0-9_./-]+$/.test(trimmed) ? trimmed : null;
}

function splitPaths(listText: string): string[] {
  return listText
    .split(',')
    .map((s) => cleanPathToken(s.trim()))
    .filter((s): s is string => s !== null);
}

function findRepoRoot(): string {
  try {
    const out = execSync('git rev-parse --path-format=absolute --git-common-dir', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (out) return dirname(out);
  } catch {
    // fall through to walk-up
  }
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

const RUN_IDS = [
  '09f73f6f-eede-42fe-aaf4-694abc8ab686',
  'e0c4dd03-da65-4a26-97dd-5a2a6e52520c',
  'ff2e91bc-eb8b-4eff-91c6-5b067f5d1e04',
  '8ec8d952-21cc-423a-b8bf-025db1e2c7b2',
  '5dc78eb1-157a-4118-8894-631df496d448',
  '891a6fec-47b3-46b4-8983-cc954eabda6d',
];

export function fetchFailureRowsFromDb(dbPath: string, runIds: string[]): FailureRow[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  const placeholders = runIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
         f.id,
         f.run_uuid,
         r.issue_number,
         COALESCE(repo.full_name, r.repo_id) AS repo_full_name,
         f.phase,
         f.kind,
         f.message,
         f.detected_at
       FROM failures f
       JOIN runs r ON f.run_uuid = r.uuid
       LEFT JOIN repositories repo ON r.repo_id = repo.id
       WHERE f.run_uuid IN (${placeholders})
       ORDER BY repo_full_name, f.run_uuid, f.detected_at, f.id`,
    )
    .all(...runIds) as FailureRow[];
  db.close();
  return rows;
}

function buildEntry(
  row: FailureRow,
  parsed: ParsedPath | null,
  truncation: TruncationInfo,
  sourceDb: SourceDb,
): ScopeReplayFixtureEntry {
  const recoverable = parsed === null ? truncation.recoverable && false : truncation.recoverable;
  const path = parsed?.path ?? null;
  const pathSource = parsed?.source ?? 'none';
  return {
    runId: row.run_uuid,
    issueNumber: row.issue_number,
    repo: row.repo_full_name,
    sourceDb,
    failureId: row.id,
    phase: row.phase,
    failureKind: row.kind,
    detectedAt: row.detected_at,
    rawMessage: row.message,
    rawMessageSha256: sha256Hex(row.message),
    path,
    pathSource,
    recoverable,
    truncatedCount: truncation.truncatedCount,
    label: 'pending_human_review',
    rationale: null,
    taskManifest: null,
  };
}

export function entriesFromRows(rows: FailureRow[], sourceDb: SourceDb): ScopeReplayFixtureEntry[] {
  const out: ScopeReplayFixtureEntry[] = [];
  for (const row of rows) {
    const { parsed, truncation } = parsePathsFromMessage(row.message);
    if (parsed.length === 0) {
      out.push(buildEntry(row, null, truncation, sourceDb));
      continue;
    }
    for (const p of parsed) {
      out.push(buildEntry(row, p, truncation, sourceDb));
    }
  }
  return out;
}

interface DbSource {
  sourceDb: SourceDb;
  dbPath: string;
}

function resolveDbSources(repoRoot: string): DbSource[] {
  const sources: DbSource[] = [];
  const automationDb =
    process.env.AI_SDLC_DB_PATH_AUTOMATION ?? join(repoRoot, '.ai-runs/orchestrator.sqlite');
  if (existsSync(automationDb)) {
    sources.push({ sourceDb: 'automation', dbPath: automationDb });
  }
  const comfyRoot =
    process.env.AI_SDLC_COMFY_ROOT ?? join(dirname(repoRoot), 'comfy-content-orchestrator');
  const comfyDb =
    process.env.AI_SDLC_DB_PATH_COMFY ?? join(comfyRoot, '.ai-runs/orchestrator.sqlite');
  if (existsSync(comfyDb)) {
    sources.push({ sourceDb: 'comfy-content-orchestrator', dbPath: comfyDb });
  }
  return sources;
}

function main(): void {
  const repoRoot = findRepoRoot();
  const fixturePath =
    process.env.SCOPE_REPLAY_FIXTURE_PATH ??
    join(process.cwd(), 'packages/application/src/__fixtures__/scope-replay-corpus.json');

  const sources = resolveDbSources(repoRoot);
  if (sources.length === 0) {
    console.error('No orchestrator.sqlite databases found.');
    process.exit(1);
  }

  const allEntries: ScopeReplayFixtureEntry[] = [];
  for (const src of sources) {
    console.warn(`Extracting failure rows from ${src.sourceDb} (${src.dbPath})...`);
    const rows = fetchFailureRowsFromDb(src.dbPath, RUN_IDS);
    console.warn(`  ${rows.length} failure rows`);
    const entries = entriesFromRows(rows, src.sourceDb);
    allEntries.push(...entries);
  }

  console.warn(`Total fixture entries: ${allEntries.length}`);

  if (process.argv.includes('--write')) {
    writeFileSync(fixturePath, JSON.stringify(allEntries, null, 2) + '\n', 'utf8');
    console.warn(`Wrote fixture corpus to ${fixturePath}`);
  } else {
    console.warn('(pass --write to persist to disk)');
    process.stdout.write(JSON.stringify(allEntries, null, 2) + '\n');
  }
}

if (process.argv[1] && process.argv[1].endsWith('extract-scope-replay-corpus.ts')) {
  main();
}
