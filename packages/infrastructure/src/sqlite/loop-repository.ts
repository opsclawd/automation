import type { Db } from './database.js';
import {
  RunId,
  PhaseName,
  type Loop,
  type LoopIteration,
  type LoopType,
  type LoopStatus,
  type LoopIterationOutcome,
} from '@ai-sdlc/domain';
import type { LoopRepositoryPort } from '@ai-sdlc/application/ports';

interface LoopRow {
  id: string;
  run_uuid: string;
  phase_id: string;
  type: string;
  max_iterations: number;
  status: string;
  started_at: string;
  completed_at: string | null;
}

interface IterationRow {
  loop_id: string;
  idx: number;
  review_invocation_id: string;
  quality_review_invocation_id: string | null;
  fix_invocation_id: string | null;
  revalidation_id: string | null;
  outcome: string | null;
  started_at: string;
  completed_at: string | null;
}

function rowToIteration(r: IterationRow): LoopIteration {
  return {
    index: r.idx,
    reviewInvocationId: r.review_invocation_id,
    startedAt: new Date(r.started_at),
    ...(r.quality_review_invocation_id !== null
      ? { qualityReviewInvocationId: r.quality_review_invocation_id }
      : {}),
    ...(r.fix_invocation_id !== null ? { fixInvocationId: r.fix_invocation_id } : {}),
    ...(r.revalidation_id !== null ? { revalidationId: r.revalidation_id } : {}),
    ...(r.outcome !== null ? { outcome: r.outcome as LoopIterationOutcome } : {}),
    ...(r.completed_at !== null ? { completedAt: new Date(r.completed_at) } : {}),
  };
}

function rowToLoop(r: LoopRow, iterations: LoopIteration[]): Loop {
  return {
    id: r.id,
    runId: RunId(r.run_uuid),
    phaseId: PhaseName(r.phase_id),
    type: r.type as LoopType,
    maxIterations: r.max_iterations,
    status: r.status as LoopStatus,
    startedAt: new Date(r.started_at),
    iterations,
    ...(r.completed_at !== null ? { completedAt: new Date(r.completed_at) } : {}),
  };
}

export class LoopRepository implements LoopRepositoryPort {
  constructor(private readonly db: Db) {}

  insert(loop: Loop): void {
    this.write(loop);
  }

  update(loop: Loop): void {
    this.write(loop);
  }

  private write(loop: Loop): void {
    const tx = this.db.transaction((l: Loop) => {
      this.db
        .prepare(
          `INSERT INTO loops (id, run_uuid, phase_id, type, max_iterations, status, started_at, completed_at)
           VALUES (@id, @run_uuid, @phase_id, @type, @max_iterations, @status, @started_at, @completed_at)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             completed_at = excluded.completed_at`,
        )
        .run({
          id: l.id,
          run_uuid: l.runId as unknown as string,
          phase_id: l.phaseId as unknown as string,
          type: l.type,
          max_iterations: l.maxIterations,
          status: l.status,
          started_at: l.startedAt.toISOString(),
          completed_at: l.completedAt ? l.completedAt.toISOString() : null,
        });

      this.db.prepare(`DELETE FROM loop_iterations WHERE loop_id = ?`).run(l.id);
      const insertIter = this.db.prepare(
        `INSERT INTO loop_iterations
           (loop_id, idx, review_invocation_id, quality_review_invocation_id, fix_invocation_id, revalidation_id, outcome, started_at, completed_at)
         VALUES (@loop_id, @idx, @review_invocation_id, @quality_review_invocation_id, @fix_invocation_id, @revalidation_id, @outcome, @started_at, @completed_at)`,
      );
      for (const it of l.iterations) {
        insertIter.run({
          loop_id: l.id,
          idx: it.index,
          review_invocation_id: it.reviewInvocationId,
          quality_review_invocation_id: it.qualityReviewInvocationId ?? null,
          fix_invocation_id: it.fixInvocationId ?? null,
          revalidation_id: it.revalidationId ?? null,
          outcome: it.outcome ?? null,
          started_at: it.startedAt.toISOString(),
          completed_at: it.completedAt ? it.completedAt.toISOString() : null,
        });
      }
    });
    tx(loop);
  }

  findById(id: string): Loop | undefined {
    const row = this.db.prepare(`SELECT * FROM loops WHERE id = ?`).get(id) as LoopRow | undefined;
    if (!row) return undefined;
    const iterations = (
      this.db
        .prepare(`SELECT * FROM loop_iterations WHERE loop_id = ? ORDER BY idx ASC`)
        .all(id) as IterationRow[]
    ).map(rowToIteration);
    return rowToLoop(row, iterations);
  }

  listForRun(runId: RunId): Loop[] {
    const rows = this.db
      .prepare(`SELECT * FROM loops WHERE run_uuid = ? ORDER BY started_at ASC`)
      .all(runId as unknown as string) as LoopRow[];

    if (rows.length === 0) return [];

    const placeholders = rows.map(() => '?').join(', ');
    const ids = rows.map((r) => r.id);
    const iterationRows = this.db
      .prepare(
        `SELECT * FROM loop_iterations WHERE loop_id IN (${placeholders}) ORDER BY loop_id, idx ASC`,
      )
      .all(...ids) as IterationRow[];

    const iterationsByLoopId = new Map<string, IterationRow[]>();
    for (const ir of iterationRows) {
      const arr = iterationsByLoopId.get(ir.loop_id);
      if (arr) {
        arr.push(ir);
      } else {
        iterationsByLoopId.set(ir.loop_id, [ir]);
      }
    }

    return rows.map((r) => rowToLoop(r, (iterationsByLoopId.get(r.id) ?? []).map(rowToIteration)));
  }
}
