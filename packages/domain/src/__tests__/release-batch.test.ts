import { describe, it, expect } from 'vitest';
import {
  ReleaseBatchId,
  RepositoryId,
  createReleaseBatch,
  admitItem,
  assignItemRun,
  markItemWaitingMerge,
  markItemMerged,
  markItemBlocked,
  markBatchBlocked,
  unblockBatch,
  unblockItem,
  attachItemPr,
  transitionToAwaitingManualTest,
  approveBatchCandidate,
  rejectBatchCandidate,
  promoteBatch,
  completeBatch,
  cancelBatch,
  ReleaseBatchStateError,
  DuplicatePositionError,
  DuplicateIssueError,
  DuplicateRunAssignmentError,
  ReassignRunError,
  ImmutableItemMergedError,
  ConcurrentAdmissionError,
  PrematureCandidateCaptureError,
  InvalidCandidateShaError,
  UnapprovedPromotionError,
  TerminalBatchError,
} from '../index.js';

const t0 = new Date('2026-09-11T12:00:00.000Z');
const t1 = new Date('2026-09-11T12:05:00.000Z');
const t2 = new Date('2026-09-11T12:10:00.000Z');

function createSampleBatch() {
  return createReleaseBatch({
    id: ReleaseBatchId('batch-1'),
    repoId: RepositoryId('opsclawd/automation'),
    sourceBranch: 'main',
    sourceStartSha: '0123456789abcdef0123456789abcdef01234567',
    releaseBranch: 'release/2026-09-11-batch-1',
    createdAt: t0,
    items: [
      { position: 1, issueNumber: 101 },
      { position: 2, issueNumber: 102 },
      { position: 3, issueNumber: 103 },
      { position: 4, issueNumber: 104 },
      { position: 5, issueNumber: 105 },
    ],
  });
}

describe('ReleaseBatch domain model & invariants', () => {
  describe('createReleaseBatch', () => {
    it('creates a release batch with 5 ordered items', () => {
      const batch = createSampleBatch();
      expect(batch.id).toBe('batch-1');
      expect(batch.status).toBe('queued');
      expect(batch.currentPosition).toBe(1);
      expect(batch.items).toHaveLength(5);
      expect(batch.items.map((i) => i.position)).toEqual([1, 2, 3, 4, 5]);
      expect(batch.items.map((i) => i.issueNumber)).toEqual([101, 102, 103, 104, 105]);
      expect(batch.items.every((i) => i.status === 'pending')).toBe(true);
    });

    it('rejects an empty item list', () => {
      expect(() =>
        createReleaseBatch({
          id: ReleaseBatchId('batch-1'),
          repoId: RepositoryId('repo-1'),
          sourceBranch: 'main',
          sourceStartSha: 'sha1',
          releaseBranch: 'release/b1',
          createdAt: t0,
          items: [],
        }),
      ).toThrow(ReleaseBatchStateError);
    });

    it('rejects non-contiguous positions', () => {
      expect(() =>
        createReleaseBatch({
          id: ReleaseBatchId('batch-1'),
          repoId: RepositoryId('repo-1'),
          sourceBranch: 'main',
          sourceStartSha: 'sha1',
          releaseBranch: 'release/b1',
          createdAt: t0,
          items: [
            { position: 1, issueNumber: 101 },
            { position: 3, issueNumber: 102 },
          ],
        }),
      ).toThrow(ReleaseBatchStateError);
    });

    it('rejects duplicate positions', () => {
      expect(() =>
        createReleaseBatch({
          id: ReleaseBatchId('batch-1'),
          repoId: RepositoryId('repo-1'),
          sourceBranch: 'main',
          sourceStartSha: 'sha1',
          releaseBranch: 'release/b1',
          createdAt: t0,
          items: [
            { position: 1, issueNumber: 101 },
            { position: 1, issueNumber: 102 },
          ],
        }),
      ).toThrow(DuplicatePositionError);
    });

    it('rejects duplicate issue numbers within the same batch', () => {
      expect(() =>
        createReleaseBatch({
          id: ReleaseBatchId('batch-1'),
          repoId: RepositoryId('repo-1'),
          sourceBranch: 'main',
          sourceStartSha: 'sha1',
          releaseBranch: 'release/b1',
          createdAt: t0,
          items: [
            { position: 1, issueNumber: 101 },
            { position: 2, issueNumber: 101 },
          ],
        }),
      ).toThrow(DuplicateIssueError);
    });

    it('rejects duplicate run UUIDs on creation', () => {
      expect(() =>
        createReleaseBatch({
          id: ReleaseBatchId('batch-1'),
          repoId: RepositoryId('repo-1'),
          sourceBranch: 'main',
          sourceStartSha: 'sha1',
          releaseBranch: 'release/b1',
          createdAt: t0,
          items: [
            { position: 1, issueNumber: 101, runUuid: 'run-1' },
            { position: 2, issueNumber: 102, runUuid: 'run-1' },
          ],
        }),
      ).toThrow(DuplicateRunAssignmentError);
    });

    it('rejects candidateSha on creation if items are not all merged', () => {
      expect(() =>
        createReleaseBatch({
          id: ReleaseBatchId('batch-1'),
          repoId: RepositoryId('repo-1'),
          sourceBranch: 'main',
          sourceStartSha: 'sha1',
          releaseBranch: 'release/b1',
          candidateSha: 'cand-sha',
          createdAt: t0,
          items: [
            { position: 1, issueNumber: 101, status: 'merged' },
            { position: 2, issueNumber: 102, status: 'pending' },
          ],
        }),
      ).toThrow(PrematureCandidateCaptureError);
    });

    it('rejects approvedCandidateSha mismatch on creation', () => {
      expect(() =>
        createReleaseBatch({
          id: ReleaseBatchId('batch-1'),
          repoId: RepositoryId('repo-1'),
          sourceBranch: 'main',
          sourceStartSha: 'sha1',
          releaseBranch: 'release/b1',
          candidateSha: 'cand-sha-1',
          approvedCandidateSha: 'cand-sha-2',
          createdAt: t0,
          items: [{ position: 1, issueNumber: 101, status: 'merged' }],
        }),
      ).toThrow(InvalidCandidateShaError);
    });
  });

  describe('admitItem', () => {
    it('admits position 1 and sets status to building', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1', baseSha: 'base-1', now: t1 });

      expect(batch.status).toBe('building');
      expect(batch.currentPosition).toBe(1);
      const item1 = batch.items[0];
      expect(item1.status).toBe('active');
      expect(item1.runUuid).toBe('run-1');
      expect(item1.baseSha).toBe('base-1');
      expect(item1.startedAt).toEqual(t1);
    });

    it('rejects admitting position 2 when position 1 is active (concurrent admission)', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1', now: t1 });

      expect(() => admitItem(batch, 2, { runUuid: 'run-2' })).toThrow(ConcurrentAdmissionError);
    });

    it('rejects admitting position 2 before position 1 is merged', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1', now: t1 });
      batch = markItemWaitingMerge(batch, 1, 555);

      expect(() => admitItem(batch, 2, { runUuid: 'run-2' })).toThrow(ConcurrentAdmissionError);
    });

    it('rejects admitting an already merged item', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1', now: t1 });
      batch = markItemWaitingMerge(batch, 1, 555);
      batch = markItemMerged(batch, 1, { mergedCommitSha: 'sha-m1', now: t2 });

      expect(() => admitItem(batch, 1)).toThrow(ImmutableItemMergedError);
    });

    it('rejects admitting item if predecessor is blocked or pending', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1', now: t1 });
      batch = markItemBlocked(batch, 1, 'agent failed');

      expect(() => admitItem(batch, 2, { runUuid: 'run-2' })).toThrow(ReleaseBatchStateError);
    });

    it('successfully admits position 2 once position 1 is merged', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1', now: t1 });
      batch = markItemWaitingMerge(batch, 1, 555);
      batch = markItemMerged(batch, 1, { mergedCommitSha: 'sha-m1', now: t2 });

      batch = admitItem(batch, 2, { runUuid: 'run-2', now: t2 });
      expect(batch.currentPosition).toBe(2);
      expect(batch.items[1].status).toBe('active');
    });

    it('unblocks batch if admitted after being blocked', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1', now: t1 });
      batch = markItemBlocked(batch, 1, 'temporary failure');
      expect(batch.status).toBe('blocked');

      batch = admitItem(batch, 1, { runUuid: 'run-1', now: t2 });
      expect(batch.status).toBe('building');
      expect(batch.blockedReason).toBeUndefined();
    });
  });

  describe('assignItemRun & Run UUID invariants', () => {
    it('assigns run UUID to item', () => {
      let batch = createSampleBatch();
      batch = assignItemRun(batch, 1, 'run-1');
      expect(batch.items[0].runUuid).toBe('run-1');
    });

    it('allows assigning the same run UUID idempotently', () => {
      let batch = createSampleBatch();
      batch = assignItemRun(batch, 1, 'run-1');
      batch = assignItemRun(batch, 1, 'run-1');
      expect(batch.items[0].runUuid).toBe('run-1');
    });

    it('rejects reassigning an item to a different run UUID', () => {
      let batch = createSampleBatch();
      batch = assignItemRun(batch, 1, 'run-1');
      expect(() => assignItemRun(batch, 1, 'run-2')).toThrow(ReassignRunError);
    });

    it('rejects attaching the same run UUID to multiple items', () => {
      let batch = createSampleBatch();
      batch = assignItemRun(batch, 1, 'run-1');
      expect(() => assignItemRun(batch, 2, 'run-1')).toThrow(DuplicateRunAssignmentError);
    });
  });

  describe('item progression & irreversible merge', () => {
    it('transitions active -> waiting_merge -> merged', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1', now: t1 });
      batch = markItemWaitingMerge(batch, 1, 999);

      expect(batch.items[0].status).toBe('waiting_merge');
      expect(batch.items[0].prNumber).toBe(999);

      batch = markItemMerged(batch, 1, { mergedCommitSha: 'merge-sha-1', now: t2 });
      expect(batch.items[0].status).toBe('merged');
      expect(batch.items[0].mergedCommitSha).toBe('merge-sha-1');
      expect(batch.items[0].completedAt).toEqual(t2);
    });

    it('rejects transitioning merged item to any other status', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1', now: t1 });
      batch = markItemMerged(batch, 1, { mergedCommitSha: 'merge-sha-1', now: t2 });

      expect(() => markItemWaitingMerge(batch, 1, 1000)).toThrow(ImmutableItemMergedError);
      expect(() => markItemBlocked(batch, 1, 'some reason')).toThrow(ImmutableItemMergedError);
      expect(() => markItemMerged(batch, 1, { mergedCommitSha: 'other-sha' })).toThrow(
        ImmutableItemMergedError,
      );
    });
  });

  describe('blocker propagation & candidate capture', () => {
    it('propagates item blockage to release batch', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1', now: t1 });
      batch = markItemBlocked(batch, 1, 'lint failed 3 times');

      expect(batch.items[0].status).toBe('blocked');
      expect(batch.items[0].blockedReason).toBe('lint failed 3 times');
      expect(batch.status).toBe('blocked');
      expect(batch.blockedReason).toBe('lint failed 3 times');
    });

    it('unblocks batch when unblockBatch is called', () => {
      let batch = createSampleBatch();
      batch = markBatchBlocked(batch, 'external network outage');
      expect(batch.status).toBe('blocked');

      batch = unblockBatch(batch);
      expect(batch.status).toBe('building');
      expect(batch.blockedReason).toBeUndefined();
    });

    it('rejects capturing candidateSha before all items are merged', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1', now: t1 });
      batch = markItemMerged(batch, 1, { mergedCommitSha: 'sha-1', now: t2 });

      // Items 2..5 are still pending
      expect(() => transitionToAwaitingManualTest(batch, 'cand-head-sha')).toThrow(
        PrematureCandidateCaptureError,
      );
    });

    it('captures candidateSha once all items are merged and moves to awaiting_manual_test', () => {
      let batch = createSampleBatch();
      for (let pos = 1; pos <= 5; pos++) {
        batch = admitItem(batch, pos, { runUuid: `run-${pos}`, now: t1 });
        batch = markItemMerged(batch, pos, { mergedCommitSha: `sha-${pos}`, now: t2 });
      }

      batch = transitionToAwaitingManualTest(batch, 'cand-head-sha');
      expect(batch.status).toBe('awaiting_manual_test');
      expect(batch.candidateSha).toBe('cand-head-sha');
    });
  });

  describe('manual test, approval, promotion, and completion', () => {
    function createFullyMergedAwaitingBatch() {
      let batch = createSampleBatch();
      for (let pos = 1; pos <= 5; pos++) {
        batch = admitItem(batch, pos, { runUuid: `run-${pos}`, now: t1 });
        batch = markItemMerged(batch, pos, { mergedCommitSha: `sha-${pos}`, now: t2 });
      }
      return transitionToAwaitingManualTest(batch, 'candidate-sha-123');
    }

    it('rejects candidate approval when approvedCandidateSha does not match candidateSha', () => {
      const batch = createFullyMergedAwaitingBatch();
      expect(() => approveBatchCandidate(batch, 'tampered-sha')).toThrow(InvalidCandidateShaError);
    });

    it('approves candidate when exact SHA matches', () => {
      let batch = createFullyMergedAwaitingBatch();
      batch = approveBatchCandidate(batch, 'candidate-sha-123');

      expect(batch.status).toBe('approved');
      expect(batch.approvedCandidateSha).toBe('candidate-sha-123');
    });

    it('can reject candidate and re-await test with new candidate', () => {
      let batch = createFullyMergedAwaitingBatch();
      batch = rejectBatchCandidate(batch, 'manual test test failure');

      expect(batch.status).toBe('test_failed');
      expect(batch.blockedReason).toBe('manual test test failure');

      // Reconciled and new candidate captured
      batch = transitionToAwaitingManualTest(batch, 'candidate-sha-456');
      expect(batch.status).toBe('awaiting_manual_test');
      expect(batch.candidateSha).toBe('candidate-sha-456');
    });

    it('rejects promoting batch without an approved candidate SHA', () => {
      const batch = createFullyMergedAwaitingBatch();
      expect(() => promoteBatch(batch)).toThrow(ReleaseBatchStateError);

      const unapproved = { ...batch, status: 'approved' as const };
      expect(() => promoteBatch(unapproved)).toThrow(UnapprovedPromotionError);
      expect(() => completeBatch(unapproved)).toThrow(UnapprovedPromotionError);
    });

    it('promotes and completes batch through lifecycle', () => {
      let batch = createFullyMergedAwaitingBatch();
      batch = approveBatchCandidate(batch, 'candidate-sha-123');
      batch = promoteBatch(batch);
      expect(batch.status).toBe('promoting');

      const doneAt = new Date('2026-09-11T13:00:00.000Z');
      batch = completeBatch(batch, doneAt);
      expect(batch.status).toBe('completed');
      expect(batch.completedAt).toEqual(doneAt);
    });

    it('cancels batch and marks cancelled', () => {
      let batch = createSampleBatch();
      batch = cancelBatch(batch, 'operator aborted', t2);

      expect(batch.status).toBe('cancelled');
      expect(batch.completedAt).toEqual(t2);
      expect(batch.blockedReason).toBe('operator aborted');
    });

    it('enforces that completed and cancelled batches are terminal', () => {
      let batch = createFullyMergedAwaitingBatch();
      batch = approveBatchCandidate(batch, 'candidate-sha-123');
      batch = promoteBatch(batch);
      batch = completeBatch(batch, t2);

      expect(() => admitItem(batch, 1)).toThrow(TerminalBatchError);
      expect(() => cancelBatch(batch)).toThrow(TerminalBatchError);
      expect(() => promoteBatch(batch)).toThrow(TerminalBatchError);
      expect(() => markBatchBlocked(batch, 'fail')).toThrow(TerminalBatchError);
    });

    it('unblocks blocked item and batch, clearing blocked reasons', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1' });
      batch = markItemBlocked(batch, 1, 'run_failed');

      expect(batch.status).toBe('blocked');
      expect(batch.blockedReason).toBe('run_failed');
      expect(batch.items[0]?.status).toBe('blocked');
      expect(batch.items[0]?.blockedReason).toBe('run_failed');

      batch = unblockItem(batch, 1);
      expect(batch.status).toBe('building');
      expect(batch.blockedReason).toBeUndefined();
      expect(batch.items[0]?.status).toBe('active');
      expect(batch.items[0]?.blockedReason).toBeUndefined();

      // Idempotent call
      const batch2 = unblockItem(batch, 1);
      expect(batch2).toEqual(batch);
    });

    it('attaches PR metadata idempotently', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1' });
      batch = attachItemPr(batch, 1, 42);

      expect(batch.items[0]?.prNumber).toBe(42);
      expect(batch.items[0]?.status).toBe('active');

      // Idempotent
      batch = attachItemPr(batch, 1, 42);
      expect(batch.items[0]?.prNumber).toBe(42);
    });

    it('allows idempotent markItemWaitingMerge with same prNumber', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1' });
      batch = markItemWaitingMerge(batch, 1, 42);
      expect(batch.items[0]?.status).toBe('waiting_merge');
      expect(batch.items[0]?.prNumber).toBe(42);

      // Idempotent call should not throw
      const batch2 = markItemWaitingMerge(batch, 1, 42);
      expect(batch2.items[0]?.status).toBe('waiting_merge');
      expect(batch2.items[0]?.prNumber).toBe(42);
    });

    it('clears item blockedReason when admitItem reactivates a blocked item', () => {
      let batch = createSampleBatch();
      batch = admitItem(batch, 1, { runUuid: 'run-1' });
      batch = markItemBlocked(batch, 1, 'run_failed');

      expect(batch.items[0]?.status).toBe('blocked');
      expect(batch.items[0]?.blockedReason).toBe('run_failed');

      batch = admitItem(batch, 1, { runUuid: 'run-1' });
      expect(batch.items[0]?.status).toBe('active');
      expect(batch.items[0]?.blockedReason).toBeUndefined();
      expect(batch.status).toBe('building');
      expect(batch.blockedReason).toBeUndefined();
    });
  });
});
