import { normalizeTaskPath, type Step, type StepStatus } from '@ai-sdlc/domain';
import type { StepRepositoryPort } from '@ai-sdlc/application/ports';
import type { Db } from './database.js';

interface StepRow {
  id: string;
  run_id: string;
  phase_id: string;
  idx: number;
  title: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  initial_pre_step_head: string | null;
  revert_counts: string | null;
}

const PHASE_ORDER: Record<string, number> = {
  read_issue: 0,
  'plan-design': 1,
  'plan-write': 2,
  implement: 3,
  validate: 4,
  'review-fix': 5,
  compound: 6,
  'create-pr': 7,
  'post-pr-review': 8,
};

export function normalizeRevertCounts(raw: unknown): Record<string, number> {
  if (!raw) return {};
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '{}') return {};
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const normKey = normalizeTaskPath(key);
    if (!normKey) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      continue;
    }
    const current = result[normKey];
    result[normKey] = current !== undefined ? Math.max(current, value) : value;
  }
  return result;
}

/** Used directly by compose.ts — implements @ai-sdlc/application StepRepositoryPort. */
export class SqliteStepRepository implements StepRepositoryPort {
  constructor(private readonly db: Db) {}

  upsert(step: Step): void {
    const revertCounts = JSON.stringify(normalizeRevertCounts(step.revertCounts));
    this.db
      .prepare(
        `INSERT INTO steps (id, run_id, phase_id, idx, title, status, started_at, completed_at, initial_pre_step_head, revert_counts)
         VALUES (@id, @run_id, @phase_id, @idx, @title, @status, @started_at, @completed_at, @initial_pre_step_head, @revert_counts)
         ON CONFLICT(run_id, phase_id, idx) DO UPDATE SET
           id = excluded.id,
           title = excluded.title,
           status = excluded.status,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at,
           initial_pre_step_head =
             COALESCE(steps.initial_pre_step_head, excluded.initial_pre_step_head),
           revert_counts =
             CASE
               WHEN excluded.revert_counts != '{}' THEN excluded.revert_counts
               ELSE steps.revert_counts
             END`,
      )
      .run({
        id: step.id,
        run_id: step.runId,
        phase_id: step.phaseId,
        idx: step.index,
        title: step.title,
        status: step.status,
        started_at: step.startedAt?.toISOString() ?? null,
        completed_at: step.completedAt?.toISOString() ?? null,
        initial_pre_step_head: step.initialPreStepHead ?? null,
        revert_counts: revertCounts,
      });
  }

  listForRun(runId: string): Step[] {
    const rows = this.db.prepare('SELECT * FROM steps WHERE run_id = ?').all(runId) as StepRow[];
    return rows
      .map((r) => rowToStep(r))
      .sort((a, b) => {
        const orderA = PHASE_ORDER[String(a.phaseId)] ?? 999;
        const orderB = PHASE_ORDER[String(b.phaseId)] ?? 999;
        if (orderA !== orderB) return orderA - orderB;
        return a.index - b.index;
      });
  }

  findByIndex(runId: string, phaseId: string, index: number): Step | undefined {
    const row = this.db
      .prepare('SELECT * FROM steps WHERE run_id = ? AND phase_id = ? AND idx = ?')
      .get(runId, phaseId, index) as StepRow | undefined;
    return row ? rowToStep(row) : undefined;
  }
}

function rowToStep(r: StepRow): Step {
  return {
    id: r.id,
    runId: r.run_id,
    phaseId: r.phase_id,
    index: r.idx,
    title: r.title,
    status: r.status as StepStatus,
    revertCounts: normalizeRevertCounts(r.revert_counts),
    ...(r.started_at !== null ? { startedAt: new Date(r.started_at) } : {}),
    ...(r.completed_at !== null ? { completedAt: new Date(r.completed_at) } : {}),
    ...(r.initial_pre_step_head !== null ? { initialPreStepHead: r.initial_pre_step_head } : {}),
  };
}
