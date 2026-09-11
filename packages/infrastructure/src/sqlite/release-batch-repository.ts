import type { Db } from './database.js';
import {
  ReleaseBatchId,
  RepositoryId,
  type ReleaseBatch,
  type ReleaseBatchItem,
  type ReleaseBatchStatus,
  type ReleaseBatchItemStatus,
  type ReleaseBatchBlockedReason,
  ReleaseBatchStateError,
  ReassignRunError,
  ImmutableItemMergedError,
} from '@ai-sdlc/domain';
import type { ReleaseBatchRepositoryPort } from '@ai-sdlc/application/ports';

interface ReleaseBatchRow {
  id: string;
  repo_id: string;
  source_branch: string;
  source_start_sha: string;
  release_branch: string;
  status: string;
  current_position: number;
  candidate_sha: string | null;
  approved_candidate_sha: string | null;
  blocked_reason: string | null;
  created_at: string;
  completed_at: string | null;
}

interface ReleaseBatchItemRow {
  release_batch_id: string;
  position: number;
  issue_number: number;
  status: string;
  run_uuid: string | null;
  pr_number: number | null;
  base_sha: string | null;
  merged_commit_sha: string | null;
  blocked_reason: string | null;
  started_at: string | null;
  completed_at: string | null;
}

function rowToReleaseBatchItem(r: ReleaseBatchItemRow): ReleaseBatchItem {
  return {
    releaseBatchId: ReleaseBatchId(r.release_batch_id),
    position: r.position,
    issueNumber: r.issue_number,
    status: r.status as ReleaseBatchItemStatus,
    ...(r.run_uuid !== null ? { runUuid: r.run_uuid } : {}),
    ...(r.pr_number !== null ? { prNumber: r.pr_number } : {}),
    ...(r.base_sha !== null ? { baseSha: r.base_sha } : {}),
    ...(r.merged_commit_sha !== null ? { mergedCommitSha: r.merged_commit_sha } : {}),
    ...(r.blocked_reason !== null
      ? { blockedReason: r.blocked_reason as ReleaseBatchBlockedReason }
      : {}),
    ...(r.started_at !== null ? { startedAt: new Date(r.started_at) } : {}),
    ...(r.completed_at !== null ? { completedAt: new Date(r.completed_at) } : {}),
  };
}

function rowToReleaseBatch(r: ReleaseBatchRow, items: ReleaseBatchItem[]): ReleaseBatch {
  return {
    id: ReleaseBatchId(r.id),
    repoId: RepositoryId(r.repo_id),
    sourceBranch: r.source_branch,
    sourceStartSha: r.source_start_sha,
    releaseBranch: r.release_branch,
    status: r.status as ReleaseBatchStatus,
    currentPosition: r.current_position,
    ...(r.candidate_sha !== null ? { candidateSha: r.candidate_sha } : {}),
    ...(r.approved_candidate_sha !== null
      ? { approvedCandidateSha: r.approved_candidate_sha }
      : {}),
    ...(r.blocked_reason !== null
      ? { blockedReason: r.blocked_reason as ReleaseBatchBlockedReason }
      : {}),
    createdAt: new Date(r.created_at),
    ...(r.completed_at !== null ? { completedAt: new Date(r.completed_at) } : {}),
    items,
  };
}

export class ReleaseBatchRepository implements ReleaseBatchRepositoryPort {
  constructor(private readonly db: Db) {}

  insert(batch: ReleaseBatch): void {
    const tx = this.db.transaction((b: ReleaseBatch) => {
      this.db
        .prepare(
          `INSERT INTO release_batches
             (id, repo_id, source_branch, source_start_sha, release_branch, status, current_position,
              candidate_sha, approved_candidate_sha, blocked_reason, created_at, completed_at)
           VALUES
             (@id, @repo_id, @source_branch, @source_start_sha, @release_branch, @status, @current_position,
              @candidate_sha, @approved_candidate_sha, @blocked_reason, @created_at, @completed_at)`,
        )
        .run({
          id: b.id,
          repo_id: b.repoId,
          source_branch: b.sourceBranch,
          source_start_sha: b.sourceStartSha,
          release_branch: b.releaseBranch,
          status: b.status,
          current_position: b.currentPosition,
          candidate_sha: b.candidateSha ?? null,
          approved_candidate_sha: b.approvedCandidateSha ?? null,
          blocked_reason: b.blockedReason ?? null,
          created_at: b.createdAt.toISOString(),
          completed_at: b.completedAt ? b.completedAt.toISOString() : null,
        });

      const insertItem = this.db.prepare(
        `INSERT INTO release_batch_items
           (release_batch_id, position, issue_number, status, run_uuid, pr_number, base_sha,
            merged_commit_sha, blocked_reason, started_at, completed_at)
         VALUES
           (@release_batch_id, @position, @issue_number, @status, @run_uuid, @pr_number, @base_sha,
            @merged_commit_sha, @blocked_reason, @started_at, @completed_at)`,
      );

      for (const item of b.items) {
        insertItem.run({
          release_batch_id: b.id,
          position: item.position,
          issue_number: item.issueNumber,
          status: item.status,
          run_uuid: item.runUuid ?? null,
          pr_number: item.prNumber ?? null,
          base_sha: item.baseSha ?? null,
          merged_commit_sha: item.mergedCommitSha ?? null,
          blocked_reason: item.blockedReason ?? null,
          started_at: item.startedAt ? item.startedAt.toISOString() : null,
          completed_at: item.completedAt ? item.completedAt.toISOString() : null,
        });
      }
    });

    tx(batch);
  }

  update(batch: ReleaseBatch): void {
    const tx = this.db.transaction((b: ReleaseBatch) => {
      const existing = this.findById(b.id);
      if (!existing) {
        throw new Error(`cannot update release batch ${b.id}: not found`);
      }

      if (existing.items.length !== b.items.length) {
        throw new ReleaseBatchStateError(
          `cannot update release batch ${b.id}: item count cannot change (expected ${existing.items.length}, got ${b.items.length})`,
        );
      }

      for (let i = 0; i < existing.items.length; i++) {
        const prev = existing.items[i];
        const next = b.items[i];
        if (!prev || !next) continue;

        if (prev.position !== next.position) {
          throw new ReleaseBatchStateError(
            `cannot reorder or alter positions: position ${prev.position} changed to ${next.position}`,
          );
        }
        if (prev.issueNumber !== next.issueNumber) {
          throw new ReleaseBatchStateError(
            `cannot change issue number for position ${prev.position}: was ${prev.issueNumber}, got ${next.issueNumber}`,
          );
        }
        if (prev.runUuid !== undefined && next.runUuid !== prev.runUuid) {
          throw new ReassignRunError(
            `cannot reassign run UUID for item at position ${prev.position}: was ${prev.runUuid}, attempted ${next.runUuid}`,
          );
        }
        if (prev.status === 'merged' && next.status !== 'merged') {
          throw new ImmutableItemMergedError(
            `cannot unmerge item at position ${prev.position}: merged is irreversible in v1`,
          );
        }
      }

      this.db
        .prepare(
          `UPDATE release_batches SET
             status = @status,
             current_position = @current_position,
             candidate_sha = @candidate_sha,
             approved_candidate_sha = @approved_candidate_sha,
             blocked_reason = @blocked_reason,
             completed_at = @completed_at
           WHERE id = @id`,
        )
        .run({
          id: b.id,
          status: b.status,
          current_position: b.currentPosition,
          candidate_sha: b.candidateSha ?? null,
          approved_candidate_sha: b.approvedCandidateSha ?? null,
          blocked_reason: b.blockedReason ?? null,
          completed_at: b.completedAt ? b.completedAt.toISOString() : null,
        });

      const updateItem = this.db.prepare(
        `UPDATE release_batch_items SET
           status = @status,
           run_uuid = @run_uuid,
           pr_number = @pr_number,
           base_sha = @base_sha,
           merged_commit_sha = @merged_commit_sha,
           blocked_reason = @blocked_reason,
           started_at = @started_at,
           completed_at = @completed_at
         WHERE release_batch_id = @release_batch_id AND position = @position`,
      );

      for (const item of b.items) {
        updateItem.run({
          release_batch_id: b.id,
          position: item.position,
          status: item.status,
          run_uuid: item.runUuid ?? null,
          pr_number: item.prNumber ?? null,
          base_sha: item.baseSha ?? null,
          merged_commit_sha: item.mergedCommitSha ?? null,
          blocked_reason: item.blockedReason ?? null,
          started_at: item.startedAt ? item.startedAt.toISOString() : null,
          completed_at: item.completedAt ? item.completedAt.toISOString() : null,
        });
      }
    });

    tx(batch);
  }

  findById(id: ReleaseBatchId): ReleaseBatch | undefined {
    const row = this.db
      .prepare(`SELECT * FROM release_batches WHERE id = ?`)
      .get(id as unknown as string) as ReleaseBatchRow | undefined;
    if (!row) return undefined;

    const itemRows = this.db
      .prepare(`SELECT * FROM release_batch_items WHERE release_batch_id = ? ORDER BY position ASC`)
      .all(id as unknown as string) as ReleaseBatchItemRow[];

    return rowToReleaseBatch(row, itemRows.map(rowToReleaseBatchItem));
  }

  findByReleaseBranch(repoId: RepositoryId, releaseBranch: string): ReleaseBatch | undefined {
    const row = this.db
      .prepare(`SELECT * FROM release_batches WHERE repo_id = ? AND release_branch = ?`)
      .get(repoId as unknown as string, releaseBranch) as ReleaseBatchRow | undefined;
    if (!row) return undefined;

    const itemRows = this.db
      .prepare(`SELECT * FROM release_batch_items WHERE release_batch_id = ? ORDER BY position ASC`)
      .all(row.id) as ReleaseBatchItemRow[];

    return rowToReleaseBatch(row, itemRows.map(rowToReleaseBatchItem));
  }

  findByRunUuid(runUuid: string): { batch: ReleaseBatch; item: ReleaseBatchItem } | undefined {
    const itemRow = this.db
      .prepare(`SELECT * FROM release_batch_items WHERE run_uuid = ?`)
      .get(runUuid) as ReleaseBatchItemRow | undefined;
    if (!itemRow) return undefined;

    const batch = this.findById(ReleaseBatchId(itemRow.release_batch_id));
    if (!batch) return undefined;

    const item = batch.items.find((i) => i.runUuid === runUuid);
    if (!item) return undefined;

    return { batch, item };
  }

  listForRepo(repoId: RepositoryId): ReleaseBatch[] {
    const rows = this.db
      .prepare(`SELECT * FROM release_batches WHERE repo_id = ? ORDER BY created_at DESC`)
      .all(repoId as unknown as string) as ReleaseBatchRow[];

    if (rows.length === 0) return [];

    const placeholders = rows.map(() => '?').join(', ');
    const ids = rows.map((r) => r.id);
    const itemRows = this.db
      .prepare(
        `SELECT * FROM release_batch_items WHERE release_batch_id IN (${placeholders}) ORDER BY release_batch_id, position ASC`,
      )
      .all(...ids) as ReleaseBatchItemRow[];

    const itemsByBatchId = new Map<string, ReleaseBatchItemRow[]>();
    for (const ir of itemRows) {
      const arr = itemsByBatchId.get(ir.release_batch_id);
      if (arr) {
        arr.push(ir);
      } else {
        itemsByBatchId.set(ir.release_batch_id, [ir]);
      }
    }

    return rows.map((r) =>
      rowToReleaseBatch(r, (itemsByBatchId.get(r.id) ?? []).map(rowToReleaseBatchItem)),
    );
  }
}
