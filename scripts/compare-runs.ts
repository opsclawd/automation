#!/usr/bin/env tsx
/**
 * compare-runs.ts — Compare two orchestrator runs from SQLite.
 *
 * Usage: pnpm run compare-runs <run-id-a> <run-id-b>
 *
 * Reads agent_invocations records and produces a markdown diff table
 * comparing per-phase model, prompt characters, duration, and outcome.
 */

import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

interface InvocationRow {
  phase_id: string;
  profile: string;
  provider: string;
  model: string;
  prompt_chars: number;
  duration_ms: number | null;
  outcome: string | null;
}

function pct(v: string): string {
  return v === '—' ? '—' : `${v}%`;
}

function findDbPath(): string {
  // Try common locations
  const candidates = [
    process.env.AI_SDLC_DB_PATH,
    './data/orchestrator.db',
    '../data/orchestrator.db',
  ];
  for (const c of candidates) {
    if (c) {
      if (existsSync(c)) return c;
    }
  }
  throw new Error(
    'Cannot find orchestrator database. Set AI_SDLC_DB_PATH or run from project root.',
  );
}

function fetchInvocations(db: Database.Database, runId: string): InvocationRow[] {
  const rows = db
    .prepare(
      `SELECT phase_id, profile, provider, model, prompt_chars, duration_ms, outcome
       FROM agent_invocations
       WHERE run_uuid = ?
       ORDER BY started_at ASC`,
    )
    .all(runId) as InvocationRow[];
  return rows;
}

function compareRuns(aId: string, bId: string): void {
  const dbPath = findDbPath();
  const db = new Database(dbPath);

  const runA = fetchInvocations(db, aId);
  const runB = fetchInvocations(db, bId);

  db.close();

  if (runA.length === 0) {
    console.error(`No invocations found for run: ${aId}`);
    process.exit(1);
  }
  if (runB.length === 0) {
    console.error(`No invocations found for run: ${bId}`);
    process.exit(1);
  }

  const totalA = { promptChars: 0, durationMs: 0, count: 0 };
  const totalB = { promptChars: 0, durationMs: 0, count: 0 };

  const phases = new Set<string>();
  const byPhaseA = new Map<string, InvocationRow[]>();
  const byPhaseB = new Map<string, InvocationRow[]>();

  for (const row of runA) {
    phases.add(row.phase_id);
    if (!byPhaseA.has(row.phase_id)) byPhaseA.set(row.phase_id, []);
    byPhaseA.get(row.phase_id)!.push(row);
    totalA.promptChars += row.prompt_chars;
    totalA.durationMs += row.duration_ms ?? 0;
    totalA.count++;
  }

  for (const row of runB) {
    phases.add(row.phase_id);
    if (!byPhaseB.has(row.phase_id)) byPhaseB.set(row.phase_id, []);
    byPhaseB.get(row.phase_id)!.push(row);
    totalB.promptChars += row.prompt_chars;
    totalB.durationMs += row.duration_ms ?? 0;
    totalB.count++;
  }

  const sortedPhases = [...phases].sort();

  const log = (msg: string) => console.log(msg);
  log(`# Run Comparison: ${aId} vs ${bId}\n`);
  log('## Per-Phase Comparison\n');
  log(
    '| Phase | Run A Model | Run B Model | A Prompt Chars | B Prompt Chars | Delta % | A Duration (ms) | B Duration (ms) | Delta % | A Outcome | B Outcome |',
  );
  log(
    '|-------|-------------|-------------|---------------|---------------|---------|-----------------|-----------------|---------|-----------|-----------|',
  );

  for (const phase of sortedPhases) {
    const aRows = byPhaseA.get(phase) ?? [];
    const bRows = byPhaseB.get(phase) ?? [];

    const aModel = aRows.map((r) => r.model).join(', ') || '—';
    const bModel = bRows.map((r) => r.model).join(', ') || '—';
    const aChars = aRows.reduce((s, r) => s + r.prompt_chars, 0);
    const bChars = bRows.reduce((s, r) => s + r.prompt_chars, 0);
    const aDur = aRows.reduce((s, r) => s + (r.duration_ms ?? 0), 0);
    const bDur = bRows.reduce((s, r) => s + (r.duration_ms ?? 0), 0);
    const aOutcome = aRows.map((r) => r.outcome ?? '—').join(', ');
    const bOutcome = bRows.map((r) => r.outcome ?? '—').join(', ');

    const charDelta = aChars > 0 ? (((bChars - aChars) / aChars) * 100).toFixed(1) : '—';
    const durDelta = aDur > 0 ? (((bDur - aDur) / aDur) * 100).toFixed(1) : '—';

    log(
      `| ${phase} | ${aModel} | ${bModel} | ${aChars} | ${bChars} | ${pct(charDelta)} | ${aDur} | ${bDur} | ${pct(durDelta)} | ${aOutcome} | ${bOutcome} |`,
    );
  }

  log('\n## Totals\n');
  const totalCharDelta =
    totalA.promptChars > 0
      ? (((totalB.promptChars - totalA.promptChars) / totalA.promptChars) * 100).toFixed(1)
      : '—';
  const totalDurDelta =
    totalA.durationMs > 0
      ? (((totalB.durationMs - totalA.durationMs) / totalA.durationMs) * 100).toFixed(1)
      : '—';

  log(`| Run | Invocations | Total Prompt Chars | Total Duration (ms) |`);
  log(`|-----|-------------|-------------------|---------------------|`);
  log(`| ${aId} | ${totalA.count} | ${totalA.promptChars} | ${totalA.durationMs} |`);
  log(`| ${bId} | ${totalB.count} | ${totalB.promptChars} | ${totalB.durationMs} |`);
  log(
    `| Delta | ${(((totalB.count - totalA.count) / Math.max(totalA.count, 1)) * 100).toFixed(1)}% | ${pct(totalCharDelta)} | ${pct(totalDurDelta)} |`,
  );
}

const [, , aId, bId] = process.argv;

if (!aId || !bId) {
  console.error('Usage: pnpm run compare-runs <run-id-a> <run-id-b>');
  process.exit(1);
}

compareRuns(aId, bId);
