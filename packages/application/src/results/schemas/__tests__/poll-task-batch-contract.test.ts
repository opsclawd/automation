import { describe, it, expect } from 'vitest';
import {
  validatePollTaskBatchResult,
  pollTaskBatchResultSchema,
  type PollTaskBatchResultEntry,
} from '../poll-task-result.js';

describe('poll-task-batch-contract', () => {
  describe('batch output rejects a missing comment id', () => {
    it('missing comment id fails exact coverage', () => {
      const expectedCommentIds = [1, 2, 3];
      const result: PollTaskBatchResultEntry[] = [
        { commentId: 1, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 3, action: 'fixed', replyBody: 'Fixed' },
      ];
      const validation = validatePollTaskBatchResult(result, expectedCommentIds);
      expect(validation.ok).toBe(false);
      expect(validation.missingIds).toContain(2);
    });

    it('multiple missing ids are reported', () => {
      const expectedCommentIds = [1, 2, 3, 4, 5];
      const result: PollTaskBatchResultEntry[] = [
        { commentId: 1, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 5, action: 'fixed', replyBody: 'Fixed' },
      ];
      const validation = validatePollTaskBatchResult(result, expectedCommentIds);
      expect(validation.ok).toBe(false);
      expect(validation.missingIds).toEqual([2, 3, 4]);
    });
  });

  describe('batch output rejects duplicate and unknown comment ids', () => {
    it('duplicate comment id fails', () => {
      const expectedCommentIds = [1, 2, 3];
      const result: PollTaskBatchResultEntry[] = [
        { commentId: 1, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 2, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 2, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 3, action: 'fixed', replyBody: 'Fixed' },
      ];
      const validation = validatePollTaskBatchResult(result, expectedCommentIds);
      expect(validation.ok).toBe(false);
      expect(validation.duplicateIds).toContain(2);
    });

    it('unknown comment id fails', () => {
      const expectedCommentIds = [1, 2, 3];
      const result: PollTaskBatchResultEntry[] = [
        { commentId: 1, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 2, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 99, action: 'fixed', replyBody: 'Fixed' },
      ];
      const validation = validatePollTaskBatchResult(result, expectedCommentIds);
      expect(validation.ok).toBe(false);
      expect(validation.unknownIds).toContain(99);
    });

    it('both duplicate and unknown ids are reported', () => {
      const expectedCommentIds = [1, 2, 3];
      const result: PollTaskBatchResultEntry[] = [
        { commentId: 1, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 1, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 99, action: 'fixed', replyBody: 'Fixed' },
      ];
      const validation = validatePollTaskBatchResult(result, expectedCommentIds);
      expect(validation.ok).toBe(false);
      expect(validation.duplicateIds).toContain(1);
      expect(validation.unknownIds).toContain(99);
    });

    it('schema-valid but duplicate array fails before any side effect', () => {
      const expectedCommentIds = [1, 2];
      const result: PollTaskBatchResultEntry[] = [
        { commentId: 1, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 1, action: 'fixed', replyBody: 'Fixed' },
      ];
      const parsed = pollTaskBatchResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
      const validation = validatePollTaskBatchResult(parsed.data!, expectedCommentIds);
      expect(validation.ok).toBe(false);
    });
  });

  describe('batch output accepts one action per expected comment id in any array order', () => {
    it('valid result with different order returns normalized order', () => {
      const expectedCommentIds = [1, 2, 3];
      const result: PollTaskBatchResultEntry[] = [
        { commentId: 3, action: 'fixed', replyBody: 'Fixed 3' },
        { commentId: 1, action: 'fixed', replyBody: 'Fixed 1' },
        { commentId: 2, action: 'fixed', replyBody: 'Fixed 2' },
      ];
      const validation = validatePollTaskBatchResult(result, expectedCommentIds);
      expect(validation.ok).toBe(true);
      expect(validation.results?.map((r) => r.commentId)).toEqual([1, 2, 3]);
    });

    it('valid result with reversed order normalizes to expected order', () => {
      const expectedCommentIds = [10, 20, 30, 40, 50];
      const result: PollTaskBatchResultEntry[] = [
        { commentId: 50, action: 'no_fix', replyBody: 'No fix' },
        { commentId: 40, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 30, action: 'blocked', replyBody: 'Blocked', blockedReason: 'build failed' },
        { commentId: 20, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 10, action: 'fixed', replyBody: 'Fixed' },
      ];
      const validation = validatePollTaskBatchResult(result, expectedCommentIds);
      expect(validation.ok).toBe(true);
      expect(validation.results?.map((r) => r.commentId)).toEqual([10, 20, 30, 40, 50]);
      expect(validation.results?.map((r) => r.action)).toEqual([
        'fixed',
        'fixed',
        'blocked',
        'fixed',
        'no_fix',
      ]);
    });

    it('single comment result normalizes correctly', () => {
      const expectedCommentIds = [42];
      const result: PollTaskBatchResultEntry[] = [
        { commentId: 42, action: 'fixed', replyBody: 'Done' },
      ];
      const validation = validatePollTaskBatchResult(result, expectedCommentIds);
      expect(validation.ok).toBe(true);
      expect(validation.results).toHaveLength(1);
      expect(validation.results![0].commentId).toBe(42);
    });

    it('preserves replyBody and blockedReason in normalized result', () => {
      const expectedCommentIds = [1, 2, 3];
      const result: PollTaskBatchResultEntry[] = [
        { commentId: 2, action: 'blocked', replyBody: 'Cannot fix', blockedReason: 'no tests' },
        { commentId: 1, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 3, action: 'no_fix', replyBody: 'Intentional' },
      ];
      const validation = validatePollTaskBatchResult(result, expectedCommentIds);
      expect(validation.ok).toBe(true);
      expect(validation.results![0].replyBody).toBe('Fixed');
      expect(validation.results![1].replyBody).toBe('Cannot fix');
      expect(validation.results![1].blockedReason).toBe('no tests');
      expect(validation.results![2].replyBody).toBe('Intentional');
    });
  });

  describe('schema validation', () => {
    it('validates correct batch result schema', () => {
      const result: PollTaskBatchResultEntry[] = [
        { commentId: 1, action: 'fixed', replyBody: 'Fixed' },
        { commentId: 2, action: 'no_fix', replyBody: 'No fix needed' },
        { commentId: 3, action: 'blocked', replyBody: 'Blocked', blockedReason: 'build error' },
      ];
      const parsed = pollTaskBatchResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });

    it('rejects invalid action', () => {
      const result = [{ commentId: 1, action: 'invalid_action', replyBody: 'test' }];
      const parsed = pollTaskBatchResultSchema.safeParse(result);
      expect(parsed.success).toBe(false);
    });

    it('rejects missing required fields', () => {
      const result = [{ commentId: 1, action: 'fixed' }];
      const parsed = pollTaskBatchResultSchema.safeParse(result);
      expect(parsed.success).toBe(false);
    });

    it('rejects negative commentId', () => {
      const result = [{ commentId: -1, action: 'fixed', replyBody: 'test' }];
      const parsed = pollTaskBatchResultSchema.safeParse(result);
      expect(parsed.success).toBe(false);
    });
  });
});
