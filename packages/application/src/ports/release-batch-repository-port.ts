import type { ReleaseBatchId, RepositoryId, ReleaseBatch, ReleaseBatchItem } from '@ai-sdlc/domain';

export interface ReleaseBatchRepositoryPort {
  /**
   * Inserts a new release batch and its ordered items.
   * Throws if batch ID already exists, or if positions/issues/run UUIDs violate unique constraints.
   */
  insert(batch: ReleaseBatch): void;

  /**
   * Updates an existing release batch and its items.
   * Enforces that item positions and issue numbers cannot change/reorder,
   * existing Run UUIDs cannot be reassigned, and merged status is irreversible.
   */
  update(batch: ReleaseBatch): void;

  /**
   * Fetches a release batch by its ID, with its ordered items (sorted by position ascending).
   * Returns undefined if not found.
   */
  findById(id: ReleaseBatchId): ReleaseBatch | undefined;

  /**
   * Fetches a release batch by repository ID and release branch name.
   */
  findByReleaseBranch(repoId: RepositoryId, releaseBranch: string): ReleaseBatch | undefined;

  /**
   * Finds the release batch and specific item associated with a Run UUID.
   */
  findByRunUuid(runUuid: string): { batch: ReleaseBatch; item: ReleaseBatchItem } | undefined;

  /**
   * Lists all release batches for a repository, ordered by createdAt descending.
   */
  listForRepo(repoId: RepositoryId): ReleaseBatch[];
}
