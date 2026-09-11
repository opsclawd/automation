import type { ReleaseBatchId, RepositoryId } from './ids.js';

export type ReleaseBatchStatus =
  | 'queued'
  | 'building'
  | 'blocked'
  | 'awaiting_manual_test'
  | 'test_failed'
  | 'approved'
  | 'promoting'
  | 'completed'
  | 'cancelled';

export type ReleaseBatchItemStatus = 'pending' | 'active' | 'waiting_merge' | 'merged' | 'blocked';

export type ReleaseBatchBlockedReason = string;

export interface ReleaseBatch {
  id: ReleaseBatchId;
  repoId: RepositoryId;
  sourceBranch: string;
  sourceStartSha: string;
  releaseBranch: string;
  status: ReleaseBatchStatus;
  currentPosition: number;
  candidateSha?: string;
  approvedCandidateSha?: string;
  blockedReason?: ReleaseBatchBlockedReason;
  createdAt: Date;
  completedAt?: Date;
  items: ReleaseBatchItem[];
}

export interface ReleaseBatchItem {
  releaseBatchId: ReleaseBatchId;
  position: number;
  issueNumber: number;
  status: ReleaseBatchItemStatus;
  runUuid?: string;
  prNumber?: number;
  baseSha?: string;
  mergedCommitSha?: string;
  blockedReason?: ReleaseBatchBlockedReason;
  startedAt?: Date;
  completedAt?: Date;
}

export class ReleaseBatchStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseBatchStateError';
    Object.setPrototypeOf(this, ReleaseBatchStateError.prototype);
  }
}

export class DuplicatePositionError extends ReleaseBatchStateError {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicatePositionError';
    Object.setPrototypeOf(this, DuplicatePositionError.prototype);
  }
}

export class DuplicateIssueError extends ReleaseBatchStateError {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateIssueError';
    Object.setPrototypeOf(this, DuplicateIssueError.prototype);
  }
}

export class DuplicateRunAssignmentError extends ReleaseBatchStateError {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateRunAssignmentError';
    Object.setPrototypeOf(this, DuplicateRunAssignmentError.prototype);
  }
}

export class ReassignRunError extends ReleaseBatchStateError {
  constructor(message: string) {
    super(message);
    this.name = 'ReassignRunError';
    Object.setPrototypeOf(this, ReassignRunError.prototype);
  }
}

export class ImmutableItemMergedError extends ReleaseBatchStateError {
  constructor(message: string) {
    super(message);
    this.name = 'ImmutableItemMergedError';
    Object.setPrototypeOf(this, ImmutableItemMergedError.prototype);
  }
}

export class ConcurrentAdmissionError extends ReleaseBatchStateError {
  constructor(message: string) {
    super(message);
    this.name = 'ConcurrentAdmissionError';
    Object.setPrototypeOf(this, ConcurrentAdmissionError.prototype);
  }
}

export class PrematureCandidateCaptureError extends ReleaseBatchStateError {
  constructor(message: string) {
    super(message);
    this.name = 'PrematureCandidateCaptureError';
    Object.setPrototypeOf(this, PrematureCandidateCaptureError.prototype);
  }
}

export class InvalidCandidateShaError extends ReleaseBatchStateError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCandidateShaError';
    Object.setPrototypeOf(this, InvalidCandidateShaError.prototype);
  }
}

export class UnapprovedPromotionError extends ReleaseBatchStateError {
  constructor(message: string) {
    super(message);
    this.name = 'UnapprovedPromotionError';
    Object.setPrototypeOf(this, UnapprovedPromotionError.prototype);
  }
}

export class TerminalBatchError extends ReleaseBatchStateError {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalBatchError';
    Object.setPrototypeOf(this, TerminalBatchError.prototype);
  }
}

const TERMINAL_STATUSES: ReadonlySet<ReleaseBatchStatus> = new Set(['completed', 'cancelled']);

function assertNotTerminal(batch: ReleaseBatch, action: string): void {
  if (TERMINAL_STATUSES.has(batch.status)) {
    throw new TerminalBatchError(
      `cannot ${action}: release batch ${batch.id} is already ${batch.status}`,
    );
  }
}

function cloneItem(item: ReleaseBatchItem): ReleaseBatchItem {
  return {
    ...item,
    ...(item.startedAt ? { startedAt: new Date(item.startedAt.getTime()) } : {}),
    ...(item.completedAt ? { completedAt: new Date(item.completedAt.getTime()) } : {}),
  };
}

export function cloneReleaseBatch(batch: ReleaseBatch): ReleaseBatch {
  return {
    ...batch,
    createdAt: new Date(batch.createdAt.getTime()),
    ...(batch.completedAt ? { completedAt: new Date(batch.completedAt.getTime()) } : {}),
    items: batch.items.map(cloneItem),
  };
}

export interface CreateReleaseBatchItemInput {
  position: number;
  issueNumber: number;
  status?: ReleaseBatchItemStatus;
  runUuid?: string;
  prNumber?: number;
  baseSha?: string;
  mergedCommitSha?: string;
  blockedReason?: ReleaseBatchBlockedReason;
  startedAt?: Date;
  completedAt?: Date;
}

export interface CreateReleaseBatchInput {
  id: ReleaseBatchId;
  repoId: RepositoryId;
  sourceBranch: string;
  sourceStartSha: string;
  releaseBranch: string;
  status?: ReleaseBatchStatus;
  currentPosition?: number;
  candidateSha?: string;
  approvedCandidateSha?: string;
  blockedReason?: ReleaseBatchBlockedReason;
  createdAt: Date;
  completedAt?: Date;
  items: CreateReleaseBatchItemInput[];
}

export function createReleaseBatch(input: CreateReleaseBatchInput): ReleaseBatch {
  if (!input.items || input.items.length === 0) {
    throw new ReleaseBatchStateError('ReleaseBatch must contain at least one item');
  }

  const sortedItems = [...input.items].sort((a, b) => a.position - b.position);

  const seenPositions = new Set<number>();
  const seenIssues = new Set<number>();
  const seenRunUuids = new Set<string>();

  for (let i = 0; i < sortedItems.length; i++) {
    const item = sortedItems[i];
    if (!item) continue;

    if (!Number.isInteger(item.position) || item.position <= 0) {
      throw new ReleaseBatchStateError(
        `item position must be a positive integer, got ${item.position}`,
      );
    }
    if (seenPositions.has(item.position)) {
      throw new DuplicatePositionError(
        `duplicate position ${item.position} in release batch ${input.id}`,
      );
    }
    seenPositions.add(item.position);

    if (item.position !== i + 1) {
      throw new ReleaseBatchStateError(
        `item positions must be contiguous 1..N: expected position ${i + 1}, got ${item.position}`,
      );
    }

    if (!Number.isInteger(item.issueNumber) || item.issueNumber <= 0) {
      throw new ReleaseBatchStateError(
        `issueNumber must be a positive integer, got ${item.issueNumber}`,
      );
    }
    if (seenIssues.has(item.issueNumber)) {
      throw new DuplicateIssueError(
        `duplicate issue number ${item.issueNumber} at position ${item.position} in release batch ${input.id}`,
      );
    }
    seenIssues.add(item.issueNumber);

    if (item.runUuid !== undefined) {
      if (typeof item.runUuid !== 'string' || item.runUuid.trim().length === 0) {
        throw new ReleaseBatchStateError('runUuid must be a non-empty string when defined');
      }
      if (seenRunUuids.has(item.runUuid)) {
        throw new DuplicateRunAssignmentError(
          `run UUID ${item.runUuid} attached to multiple items in release batch ${input.id}`,
        );
      }
      seenRunUuids.add(item.runUuid);
    }
  }

  const items: ReleaseBatchItem[] = sortedItems.map((item) => ({
    releaseBatchId: input.id,
    position: item.position,
    issueNumber: item.issueNumber,
    status: item.status ?? 'pending',
    ...(item.runUuid !== undefined ? { runUuid: item.runUuid } : {}),
    ...(item.prNumber !== undefined ? { prNumber: item.prNumber } : {}),
    ...(item.baseSha !== undefined ? { baseSha: item.baseSha } : {}),
    ...(item.mergedCommitSha !== undefined ? { mergedCommitSha: item.mergedCommitSha } : {}),
    ...(item.blockedReason !== undefined ? { blockedReason: item.blockedReason } : {}),
    ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}),
    ...(item.completedAt !== undefined ? { completedAt: item.completedAt } : {}),
  }));

  if (input.candidateSha !== undefined) {
    const unmerged = items.find((i) => i.status !== 'merged');
    if (unmerged) {
      throw new PrematureCandidateCaptureError(
        `cannot capture candidateSha: item at position ${unmerged.position} is not merged (status: ${unmerged.status})`,
      );
    }
  }

  if (input.approvedCandidateSha !== undefined) {
    if (input.candidateSha === undefined || input.approvedCandidateSha !== input.candidateSha) {
      throw new InvalidCandidateShaError(
        `approved candidate SHA (${input.approvedCandidateSha}) does not match candidate SHA (${input.candidateSha})`,
      );
    }
  }

  const status = input.status ?? 'queued';

  if (status === 'completed') {
    if (!input.completedAt) {
      throw new ReleaseBatchStateError('completed status requires completedAt timestamp');
    }
    if (!input.approvedCandidateSha) {
      throw new UnapprovedPromotionError('completed status requires an approvedCandidateSha');
    }
  }

  return {
    id: input.id,
    repoId: input.repoId,
    sourceBranch: input.sourceBranch,
    sourceStartSha: input.sourceStartSha,
    releaseBranch: input.releaseBranch,
    status,
    currentPosition: input.currentPosition ?? 1,
    ...(input.candidateSha !== undefined ? { candidateSha: input.candidateSha } : {}),
    ...(input.approvedCandidateSha !== undefined
      ? { approvedCandidateSha: input.approvedCandidateSha }
      : {}),
    ...(input.blockedReason !== undefined ? { blockedReason: input.blockedReason } : {}),
    createdAt: input.createdAt,
    ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
    items,
  };
}

export function admitItem(
  batch: ReleaseBatch,
  position: number,
  input?: { runUuid?: string; baseSha?: string; now?: Date },
): ReleaseBatch {
  assertNotTerminal(batch, 'admit item');

  const itemIndex = batch.items.findIndex((i) => i.position === position);
  if (itemIndex === -1) {
    throw new ReleaseBatchStateError(
      `cannot admit item: position ${position} not found in release batch ${batch.id}`,
    );
  }

  const item = batch.items[itemIndex];
  if (!item) {
    throw new ReleaseBatchStateError(
      `cannot admit item: position ${position} not found in release batch ${batch.id}`,
    );
  }

  if (item.status === 'merged') {
    throw new ImmutableItemMergedError(
      `cannot admit item at position ${position}: item is already merged`,
    );
  }

  // Invariant 5: Only one item may be current/admitted at a time.
  const activeItem = batch.items.find(
    (i) => i.position !== position && (i.status === 'active' || i.status === 'waiting_merge'),
  );
  if (activeItem) {
    throw new ConcurrentAdmissionError(
      `cannot admit item at position ${position}: item at position ${activeItem.position} is already ${activeItem.status}`,
    );
  }

  // Invariant: Successor cannot be admitted until all predecessor items are merged.
  const unmergedPrior = batch.items.find((i) => i.position < position && i.status !== 'merged');
  if (unmergedPrior) {
    throw new ReleaseBatchStateError(
      `cannot admit item at position ${position}: predecessor at position ${unmergedPrior.position} is not merged (status: ${unmergedPrior.status})`,
    );
  }

  // Check run UUID rules if provided
  if (input?.runUuid !== undefined) {
    if (item.runUuid !== undefined && item.runUuid !== input.runUuid) {
      throw new ReassignRunError(
        `cannot reassign run UUID for item at position ${position}: already assigned to ${item.runUuid}`,
      );
    }
    const duplicate = batch.items.find(
      (i) => i.position !== position && i.runUuid === input.runUuid,
    );
    if (duplicate) {
      throw new DuplicateRunAssignmentError(
        `run UUID ${input.runUuid} is already attached to item at position ${duplicate.position}`,
      );
    }
  }

  const now = input?.now ?? new Date();
  const nextItem: ReleaseBatchItem = {
    ...item,
    status: 'active',
    startedAt: item.startedAt ?? now,
    ...(input?.runUuid !== undefined ? { runUuid: input.runUuid } : {}),
    ...(input?.baseSha !== undefined ? { baseSha: input.baseSha } : {}),
  };

  const nextItems = [...batch.items];
  nextItems[itemIndex] = nextItem;

  const nextBatchStatus: ReleaseBatchStatus =
    batch.status === 'queued' || batch.status === 'blocked' ? 'building' : batch.status;

  const { blockedReason: _br, ...restBatch } = batch;
  void _br;

  return {
    ...restBatch,
    status: nextBatchStatus,
    currentPosition: position,
    items: nextItems,
  };
}

export function assignItemRun(
  batch: ReleaseBatch,
  position: number,
  runUuid: string,
): ReleaseBatch {
  assertNotTerminal(batch, 'assign run UUID');

  if (typeof runUuid !== 'string' || runUuid.trim().length === 0) {
    throw new ReleaseBatchStateError('runUuid must be a non-empty string');
  }

  const itemIndex = batch.items.findIndex((i) => i.position === position);
  if (itemIndex === -1) {
    throw new ReleaseBatchStateError(`position ${position} not found in release batch ${batch.id}`);
  }

  const item = batch.items[itemIndex];
  if (!item) {
    throw new ReleaseBatchStateError(`position ${position} not found in release batch ${batch.id}`);
  }

  if (item.runUuid === runUuid) {
    return batch; // Idempotent assignment
  }
  if (item.runUuid !== undefined) {
    throw new ReassignRunError(
      `cannot reassign run UUID for item at position ${position}: already assigned to ${item.runUuid}`,
    );
  }

  const duplicate = batch.items.find((i) => i.position !== position && i.runUuid === runUuid);
  if (duplicate) {
    throw new DuplicateRunAssignmentError(
      `run UUID ${runUuid} is already attached to item at position ${duplicate.position}`,
    );
  }

  const nextItems = [...batch.items];
  nextItems[itemIndex] = { ...item, runUuid };

  return { ...batch, items: nextItems };
}

export function markItemWaitingMerge(
  batch: ReleaseBatch,
  position: number,
  prNumber: number,
): ReleaseBatch {
  assertNotTerminal(batch, 'mark item waiting merge');

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    throw new ReleaseBatchStateError(`prNumber must be a positive integer, got ${prNumber}`);
  }

  const itemIndex = batch.items.findIndex((i) => i.position === position);
  if (itemIndex === -1) {
    throw new ReleaseBatchStateError(`position ${position} not found in release batch ${batch.id}`);
  }

  const item = batch.items[itemIndex];
  if (!item) {
    throw new ReleaseBatchStateError(`position ${position} not found in release batch ${batch.id}`);
  }

  if (item.status === 'merged') {
    throw new ImmutableItemMergedError(
      `cannot mark item at position ${position} waiting_merge: item is already merged`,
    );
  }
  if (item.status !== 'active') {
    throw new ReleaseBatchStateError(
      `cannot mark item at position ${position} waiting_merge: status is ${item.status}, expected 'active'`,
    );
  }

  const nextItems = [...batch.items];
  nextItems[itemIndex] = { ...item, status: 'waiting_merge', prNumber };

  return { ...batch, items: nextItems };
}

export function markItemMerged(
  batch: ReleaseBatch,
  position: number,
  input: { mergedCommitSha: string; now?: Date },
): ReleaseBatch {
  assertNotTerminal(batch, 'mark item merged');

  if (!input.mergedCommitSha || input.mergedCommitSha.trim().length === 0) {
    throw new ReleaseBatchStateError('mergedCommitSha must be a non-empty string');
  }

  const itemIndex = batch.items.findIndex((i) => i.position === position);
  if (itemIndex === -1) {
    throw new ReleaseBatchStateError(`position ${position} not found in release batch ${batch.id}`);
  }

  const item = batch.items[itemIndex];
  if (!item) {
    throw new ReleaseBatchStateError(`position ${position} not found in release batch ${batch.id}`);
  }

  if (item.status === 'merged') {
    throw new ImmutableItemMergedError(
      `item at position ${position} is already merged: merged is irreversible`,
    );
  }
  if (item.status !== 'waiting_merge' && item.status !== 'active') {
    throw new ReleaseBatchStateError(
      `cannot mark item at position ${position} merged: status is ${item.status}, expected 'waiting_merge' or 'active'`,
    );
  }

  const now = input.now ?? new Date();
  const nextItems = [...batch.items];
  nextItems[itemIndex] = {
    ...item,
    status: 'merged',
    mergedCommitSha: input.mergedCommitSha,
    completedAt: now,
  };

  return { ...batch, items: nextItems };
}

export function markItemBlocked(
  batch: ReleaseBatch,
  position: number,
  reason: ReleaseBatchBlockedReason,
): ReleaseBatch {
  assertNotTerminal(batch, 'mark item blocked');

  const itemIndex = batch.items.findIndex((i) => i.position === position);
  if (itemIndex === -1) {
    throw new ReleaseBatchStateError(`position ${position} not found in release batch ${batch.id}`);
  }

  const item = batch.items[itemIndex];
  if (!item) {
    throw new ReleaseBatchStateError(`position ${position} not found in release batch ${batch.id}`);
  }

  if (item.status === 'merged') {
    throw new ImmutableItemMergedError(
      `cannot mark item at position ${position} blocked: item is already merged`,
    );
  }

  const nextItems = [...batch.items];
  nextItems[itemIndex] = { ...item, status: 'blocked', blockedReason: reason };

  return {
    ...batch,
    status: 'blocked',
    blockedReason: reason,
    items: nextItems,
  };
}

export function markBatchBlocked(
  batch: ReleaseBatch,
  reason: ReleaseBatchBlockedReason,
): ReleaseBatch {
  assertNotTerminal(batch, 'mark batch blocked');
  return { ...batch, status: 'blocked', blockedReason: reason };
}

export function unblockBatch(batch: ReleaseBatch): ReleaseBatch {
  assertNotTerminal(batch, 'unblock batch');
  if (batch.status !== 'blocked') {
    return batch;
  }
  const { blockedReason: _br, ...rest } = batch;
  void _br;
  return { ...rest, status: 'building' };
}

export function transitionToAwaitingManualTest(
  batch: ReleaseBatch,
  candidateSha: string,
): ReleaseBatch {
  assertNotTerminal(batch, 'transition to awaiting manual test');

  if (batch.status !== 'building' && batch.status !== 'test_failed') {
    throw new ReleaseBatchStateError(
      `cannot transition to awaiting_manual_test: batch status is '${batch.status}', expected 'building' or 'test_failed'`,
    );
  }

  if (!candidateSha || candidateSha.trim().length === 0) {
    throw new ReleaseBatchStateError('candidateSha must be a non-empty string');
  }

  // Invariant 6: candidateSha may only be captured after all items are merged.
  const unmerged = batch.items.find((i) => i.status !== 'merged');
  if (unmerged) {
    throw new PrematureCandidateCaptureError(
      `cannot capture candidateSha: item at position ${unmerged.position} is not merged (status: ${unmerged.status})`,
    );
  }

  const { blockedReason: _br, approvedCandidateSha: _ac, ...rest } = batch;
  void _br;
  void _ac;

  return {
    ...rest,
    status: 'awaiting_manual_test',
    candidateSha,
  };
}

export function approveBatchCandidate(
  batch: ReleaseBatch,
  approvedCandidateSha: string,
): ReleaseBatch {
  assertNotTerminal(batch, 'approve candidate');

  if (batch.status !== 'awaiting_manual_test') {
    throw new ReleaseBatchStateError(
      `cannot approve candidate: batch status is '${batch.status}', expected 'awaiting_manual_test'`,
    );
  }

  if (!batch.candidateSha) {
    throw new ReleaseBatchStateError('cannot approve candidate: batch has no candidateSha');
  }

  // Invariant 7: approvedCandidateSha must equal the candidate that was manually approved.
  if (approvedCandidateSha !== batch.candidateSha) {
    throw new InvalidCandidateShaError(
      `approved candidate SHA (${approvedCandidateSha}) does not match candidate SHA (${batch.candidateSha})`,
    );
  }

  return {
    ...batch,
    status: 'approved',
    approvedCandidateSha,
  };
}

export function rejectBatchCandidate(
  batch: ReleaseBatch,
  reason?: ReleaseBatchBlockedReason,
): ReleaseBatch {
  assertNotTerminal(batch, 'reject candidate');

  if (batch.status !== 'awaiting_manual_test') {
    throw new ReleaseBatchStateError(
      `cannot reject candidate: batch status is '${batch.status}', expected 'awaiting_manual_test'`,
    );
  }

  return {
    ...batch,
    status: 'test_failed',
    ...(reason !== undefined ? { blockedReason: reason } : {}),
  };
}

export function promoteBatch(batch: ReleaseBatch): ReleaseBatch {
  assertNotTerminal(batch, 'promote batch');

  if (batch.status !== 'approved') {
    throw new ReleaseBatchStateError(
      `cannot promote release batch: status is '${batch.status}', expected 'approved'`,
    );
  }

  // Invariant 9: A release batch may not be promoted without an approved candidate SHA.
  if (!batch.approvedCandidateSha || batch.approvedCandidateSha !== batch.candidateSha) {
    throw new UnapprovedPromotionError(
      'cannot promote release batch: approved candidate SHA is missing or does not match candidate SHA',
    );
  }

  return {
    ...batch,
    status: 'promoting',
  };
}

export function completeBatch(batch: ReleaseBatch, now?: Date): ReleaseBatch {
  assertNotTerminal(batch, 'complete batch');

  if (batch.status !== 'promoting' && batch.status !== 'approved') {
    throw new ReleaseBatchStateError(
      `cannot complete release batch: status is '${batch.status}', expected 'promoting' or 'approved'`,
    );
  }

  if (!batch.approvedCandidateSha || batch.approvedCandidateSha !== batch.candidateSha) {
    throw new UnapprovedPromotionError(
      'cannot complete release batch: approved candidate SHA is missing or does not match candidate SHA',
    );
  }

  return {
    ...batch,
    status: 'completed',
    completedAt: now ?? new Date(),
  };
}

export function cancelBatch(batch: ReleaseBatch, reason?: string, now?: Date): ReleaseBatch {
  if (batch.status === 'completed') {
    throw new TerminalBatchError('cannot cancel completed release batch');
  }
  if (batch.status === 'cancelled') {
    return batch;
  }

  return {
    ...batch,
    status: 'cancelled',
    completedAt: now ?? new Date(),
    ...(reason !== undefined ? { blockedReason: reason } : {}),
  };
}
