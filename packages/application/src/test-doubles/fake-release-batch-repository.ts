import {
  type ReleaseBatch,
  type ReleaseBatchId,
  type ReleaseBatchItem,
  type RepositoryId,
  cloneReleaseBatch,
  DuplicatePositionError,
  DuplicateIssueError,
  DuplicateRunAssignmentError,
  ReassignRunError,
  ImmutableItemMergedError,
  ReleaseBatchStateError,
} from '@ai-sdlc/domain';
import type { ReleaseBatchRepositoryPort } from '../ports/release-batch-repository-port.js';

export class FakeReleaseBatchRepository implements ReleaseBatchRepositoryPort {
  private readonly batches = new Map<string, ReleaseBatch>();

  insert(batch: ReleaseBatch): void {
    if (this.batches.has(batch.id)) {
      throw new Error(`release batch already exists: ${batch.id}`);
    }

    const seenPositions = new Set<number>();
    const seenIssues = new Set<number>();

    for (const item of batch.items) {
      if (seenPositions.has(item.position)) {
        throw new DuplicatePositionError(
          `duplicate position ${item.position} in release batch ${batch.id}`,
        );
      }
      seenPositions.add(item.position);

      if (seenIssues.has(item.issueNumber)) {
        throw new DuplicateIssueError(
          `duplicate issue number ${item.issueNumber} in release batch ${batch.id}`,
        );
      }
      seenIssues.add(item.issueNumber);

      if (item.runUuid !== undefined) {
        this.assertRunUuidAvailable(item.runUuid, batch.id, item.position);
      }
    }

    this.batches.set(batch.id, cloneReleaseBatch(batch));
  }

  update(batch: ReleaseBatch): void {
    const existing = this.batches.get(batch.id);
    if (!existing) {
      throw new Error(`cannot update release batch ${batch.id}: not found`);
    }

    if (existing.items.length !== batch.items.length) {
      throw new ReleaseBatchStateError(
        `cannot update release batch ${batch.id}: item count cannot change (expected ${existing.items.length}, got ${batch.items.length})`,
      );
    }

    for (let i = 0; i < existing.items.length; i++) {
      const prev = existing.items[i];
      const next = batch.items[i];
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
      if (next.runUuid !== undefined && next.runUuid !== prev.runUuid) {
        this.assertRunUuidAvailable(next.runUuid, batch.id, next.position);
      }
    }

    this.batches.set(batch.id, cloneReleaseBatch(batch));
  }

  findById(id: ReleaseBatchId): ReleaseBatch | undefined {
    const found = this.batches.get(id);
    return found ? cloneReleaseBatch(found) : undefined;
  }

  findByReleaseBranch(repoId: RepositoryId, releaseBranch: string): ReleaseBatch | undefined {
    for (const b of this.batches.values()) {
      if (b.repoId === repoId && b.releaseBranch === releaseBranch) {
        return cloneReleaseBatch(b);
      }
    }
    return undefined;
  }

  findByRunUuid(runUuid: string): { batch: ReleaseBatch; item: ReleaseBatchItem } | undefined {
    for (const b of this.batches.values()) {
      for (const item of b.items) {
        if (item.runUuid === runUuid) {
          const clonedBatch = cloneReleaseBatch(b);
          const clonedItem = clonedBatch.items.find((i) => i.runUuid === runUuid);
          if (clonedItem) {
            return { batch: clonedBatch, item: clonedItem };
          }
        }
      }
    }
    return undefined;
  }

  listForRepo(repoId: RepositoryId): ReleaseBatch[] {
    const matching: ReleaseBatch[] = [];
    for (const b of this.batches.values()) {
      if (b.repoId === repoId) {
        matching.push(cloneReleaseBatch(b));
      }
    }
    return matching.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  private assertRunUuidAvailable(
    runUuid: string,
    currentBatchId: string,
    currentPosition: number,
  ): void {
    for (const b of this.batches.values()) {
      for (const item of b.items) {
        if (item.runUuid === runUuid) {
          if (b.id === currentBatchId && item.position === currentPosition) {
            continue;
          }
          throw new DuplicateRunAssignmentError(
            `run UUID ${runUuid} is already attached to item at position ${item.position} in batch ${b.id}`,
          );
        }
      }
    }
  }
}
