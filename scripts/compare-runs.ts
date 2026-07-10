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
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';

interface InvocationRow {
  id: string;
  phase_id: string;
  profile: string;
  provider: string;
  model: string;
  prompt_chars: number;
  duration_ms: number | null;
  outcome: string | null;
  prompt_hash: string | null;
  metadata: string | null;
  fallback_of_invocation_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cached_tokens: number | null;
}

function pct(v: string | number): string {
  if (typeof v === 'number') {
    return `${v.toFixed(1)}%`;
  }
  return v === '—' ? '—' : `${v}%`;
}

function normalizePhase(phaseId: string): string {
  return phaseId.replace(/(-task)?-\d+$/, '');
}

interface UsageMetrics {
  inputTokens: number;
  cachedTokens: number;
  freshInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  hasUsage: boolean;
}

function getUsage(rows: InvocationRow[]): UsageMetrics {
  let inputTokens = 0;
  let cachedTokens = 0;
  let freshInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let hasUsage = false;

  for (const r of rows) {
    if (r.input_tokens !== null) {
      hasUsage = true;
      inputTokens += r.input_tokens;
      const cached = r.cached_tokens ?? 0;
      cachedTokens += cached;
      freshInputTokens += Math.max(r.input_tokens - cached, 0);
      outputTokens += r.output_tokens ?? 0;
      reasoningTokens += r.reasoning_tokens ?? 0;
    }
  }

  return { inputTokens, cachedTokens, freshInputTokens, outputTokens, reasoningTokens, hasUsage };
}

function formatUsage(u: UsageMetrics): string {
  if (!u.hasUsage) return '—';
  const hitRate = u.inputTokens > 0 ? (u.cachedTokens / u.inputTokens) * 100 : 0;
  return `Fresh: ${u.freshInputTokens}, In: ${u.inputTokens}, Hit: ${hitRate.toFixed(1)}%, Out: ${u.outputTokens}${u.reasoningTokens > 0 ? ` (Reasoning: ${u.reasoningTokens})` : ''}`;
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

function findDbPath(): string {
  const candidates = [
    process.env.AI_SDLC_DB_PATH,
    join(findRepoRoot(), '.ai-runs', 'orchestrator.sqlite'),
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
      `SELECT
         i.id,
         i.phase_id,
         i.profile,
         i.provider,
         i.model,
         i.prompt_chars,
         i.duration_ms,
         i.outcome,
         i.prompt_hash,
         i.metadata,
         i.fallback_of_invocation_id,
         u.input_tokens,
         u.output_tokens,
         u.reasoning_tokens,
         u.cached_tokens
       FROM agent_invocations i
       LEFT JOIN agent_usage u ON i.id = u.invocation_id
       WHERE i.run_uuid = ?
       ORDER BY i.started_at ASC`,
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
    const phase = normalizePhase(row.phase_id);
    phases.add(phase);
    if (!byPhaseA.has(phase)) byPhaseA.set(phase, []);
    byPhaseA.get(phase)!.push(row);
    totalA.promptChars += row.prompt_chars;
    totalA.durationMs += row.duration_ms ?? 0;
    totalA.count++;
  }

  for (const row of runB) {
    const phase = normalizePhase(row.phase_id);
    phases.add(phase);
    if (!byPhaseB.has(phase)) byPhaseB.set(phase, []);
    byPhaseB.get(phase)!.push(row);
    totalB.promptChars += row.prompt_chars;
    totalB.durationMs += row.duration_ms ?? 0;
    totalB.count++;
  }

  const sortedPhases = [...phases].sort();

  const log = (msg: string): void => {
    process.stdout.write(msg + '\n');
  };
  log(`# Run Comparison: ${aId} vs ${bId}\n`);
  log('## Per-Phase Comparison\n');
  log(
    '| Phase | Run A Model | Run B Model | A Token Usage | B Token Usage | Delta Fresh % | A Duration (ms) | B Duration (ms) | Delta % | A Outcome | B Outcome |',
  );
  log(
    '|-------|-------------|-------------|---------------|---------------|---------------|-----------------|-----------------|---------|-----------|-----------|',
  );

  for (const phase of sortedPhases) {
    const aRows = byPhaseA.get(phase) ?? [];
    const bRows = byPhaseB.get(phase) ?? [];

    const aModel = [...new Set(aRows.map((r) => r.model))].join(', ') || '—';
    const bModel = [...new Set(bRows.map((r) => r.model))].join(', ') || '—';
    const aUsage = getUsage(aRows);
    const bUsage = getUsage(bRows);
    const aDur = aRows.reduce((s, r) => s + (r.duration_ms ?? 0), 0);
    const bDur = bRows.reduce((s, r) => s + (r.duration_ms ?? 0), 0);
    const aOutcome = aRows.map((r) => (r.phase_id !== phase ? `${r.phase_id}:${r.outcome ?? '—'}` : (r.outcome ?? '—'))).join(', ');
    const bOutcome = bRows.map((r) => (r.phase_id !== phase ? `${r.phase_id}:${r.outcome ?? '—'}` : (r.outcome ?? '—'))).join(', ');

    const freshDelta = aUsage.hasUsage && bUsage.hasUsage && aUsage.freshInputTokens > 0
      ? (((bUsage.freshInputTokens - aUsage.freshInputTokens) / aUsage.freshInputTokens) * 100).toFixed(1)
      : '—';
    const durDelta = aDur > 0 ? (((bDur - aDur) / aDur) * 100).toFixed(1) : '—';

    log(
      `| ${phase} | ${aModel} | ${bModel} | ${formatUsage(aUsage)} | ${formatUsage(bUsage)} | ${pct(freshDelta)} | ${aDur} | ${bDur} | ${pct(durDelta)} | ${aOutcome} | ${bOutcome} |`,
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

  const usageA = getUsage(runA);
  const usageB = getUsage(runB);

  log(`| Run | Invocations | Fresh Input Tokens | Total Input Tokens | Hit Rate | Total Duration (ms) |`);
  log(`|-----|-------------|--------------------|-------------------|----------|---------------------|`);
  log(`| ${aId} | ${totalA.count} | ${usageA.freshInputTokens} | ${usageA.inputTokens} | ${usageA.inputTokens > 0 ? ((usageA.cachedTokens / usageA.inputTokens) * 100).toFixed(1) : 0}% | ${totalA.durationMs} |`);
  log(`| ${bId} | ${totalB.count} | ${usageB.freshInputTokens} | ${usageB.inputTokens} | ${usageB.inputTokens > 0 ? ((usageB.cachedTokens / usageB.inputTokens) * 100).toFixed(1) : 0}% | ${totalB.durationMs} |`);
  const totalFreshDelta = usageA.freshInputTokens > 0
    ? (((usageB.freshInputTokens - usageA.freshInputTokens) / usageA.freshInputTokens) * 100).toFixed(1)
    : '—';
  log(
    `| Delta | ${(((totalB.count - totalA.count) / Math.max(totalA.count, 1)) * 100).toFixed(1)}% | ${pct(totalFreshDelta)} (Fresh) | ${pct(totalCharDelta)} (Chars) | — | ${pct(totalDurDelta)} |`,
  );

  log('\n## Invocation Amplification\n');
  log('| Run | Task Invocations | Comments Processed | Invs/Task | Invs/Comment | Duplicate Invs |');
  log('|-----|------------------|--------------------|-----------|--------------|----------------|');

  const statsA = getAmplification(runA);
  const statsB = getAmplification(runB);

  log(`| ${aId} | ${statsA.tasks} | ${statsA.comments} | ${statsA.invsPerTask} | ${statsA.invsPerComment} | ${statsA.duplicates} |`);
  log(`| ${bId} | ${statsB.tasks} | ${statsB.comments} | ${statsB.invsPerTask} | ${statsB.invsPerComment} | ${statsB.duplicates} |`);
}

function getAmplification(rows: InvocationRow[]): { tasks: number; comments: number; invsPerTask: string; invsPerComment: string; duplicates: number } {
  const taskInvs = new Map<number, number>();
  const commentInvs = new Map<number, number>();
  const hashes = new Set<string>();
  let duplicates = 0;

  for (const r of rows) {
    if (r.prompt_hash) {
      if (hashes.has(r.prompt_hash)) duplicates++;
      else hashes.add(r.prompt_hash);
    }

    try {
      const meta = r.metadata ? JSON.parse(r.metadata) : {};
      if (meta.implementation_task_number !== undefined) {
        const tn = meta.implementation_task_number;
        taskInvs.set(tn, (taskInvs.get(tn) ?? 0) + 1);
      }
      if (meta.pr_review_comment_id !== undefined) {
        const cn = meta.pr_review_comment_id;
        commentInvs.set(cn, (commentInvs.get(cn) ?? 0) + 1);
      }
    } catch {
      // ignore
    }
  }

  const tasks = taskInvs.size;
  const comments = commentInvs.size;
  const totalTaskInvs = [...taskInvs.values()].reduce((a, b) => a + b, 0);
  const totalCommentInvs = [...commentInvs.values()].reduce((a, b) => a + b, 0);

  return {
    tasks,
    comments,
    invsPerTask: tasks > 0 ? (totalTaskInvs / tasks).toFixed(2) : '—',
    invsPerComment: comments > 0 ? (totalCommentInvs / comments).toFixed(2) : '—',
    duplicates,
  };
}

const [, , aId, bId] = process.argv;

if (!aId || !bId) {
  console.error('Usage: pnpm run compare-runs <run-id-a> <run-id-b>');
  process.exit(1);
}

compareRuns(aId, bId);
