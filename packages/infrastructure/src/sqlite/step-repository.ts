import type { Step, StepStatus } from '@ai-sdlc/domain';
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

/** Used directly by compose.ts — implements @ai-sdlc/application StepRepositoryPort. */
export class SqliteStepRepository implements StepRepositoryPort {
  constructor(private readonly db: Db) {}

  upsert(step: Step): void {
    this.db
      .prepare(
        `INSERT INTO steps (id, run_id, phase_id, idx, title, status, started_at, completed_at)
         VALUES (@id, @run_id, @phase_id, @idx, @title, @status, @started_at, @completed_at)
         ON CONFLICT(run_id, phase_id, idx) DO UPDATE SET
           id = excluded.id,
           title = excluded.title,
           status = excluded.status,
           started_at = excluded.started_at,
           completed_at = excluded.completed_at`,
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
    ...(r.started_at !== null ? { startedAt: new Date(r.started_at) } : {}),
    ...(r.completed_at !== null ? { completedAt: new Date(r.completed_at) } : {}),
  };
}
