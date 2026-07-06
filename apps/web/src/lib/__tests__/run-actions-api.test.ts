import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  cancelRunAction,
  retryRunAction,
  resumeRunAction,
  RunActionConfirmationRequiredError,
  type RunActionSuccessDto,
  type ConfirmationRequiredDto,
} from '../api-client';

describe('run actions API client', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mockRun = {
    uuid: 'uuid-123',
    displayId: 'R-1',
    issueNumber: 1,
    status: 'failed',
    currentPhase: 'create-pr',
    completedPhases: [],
    repoId: 'owner/repo',
    startedAt: '2026-06-29',
    completedAt: null,
    exitCode: null,
    durationMs: null,
    failureReason: null,
  };

  const successPayload: RunActionSuccessDto = {
    run: mockRun,
    action: 'retry',
    targetPhase: 'create-pr',
    requiresConfirmation: false,
  };

  const confirmationRequiredPayload: ConfirmationRequiredDto = {
    error: 'confirmation_required',
    requiresConfirmation: true,
    action: 'retry',
    targetPhase: 'create-pr',
    retrySafety: 'unsafe',
    message: 'Retrying this phase can duplicate side effects. Confirm to continue.',
  };

  describe('cancelRunAction', () => {
    it('handles success', async () => {
      const cancelSuccess: RunActionSuccessDto = { ...successPayload, action: 'cancel' };
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(cancelSuccess),
      });

      const res = await cancelRunAction('uuid-123', 'some reason');
      expect(res).toEqual(cancelSuccess);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/runs/uuid-123/cancel'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ reason: 'some reason' }),
        }),
      );
    });

    it('handles generic error', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(cancelRunAction('uuid-123')).rejects.toThrow('failed to cancel run action: 500');
    });
  });

  describe('retryRunAction', () => {
    it('handles success', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(successPayload),
      });

      const res = await retryRunAction('uuid-123', true);
      expect(res).toEqual(successPayload);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/runs/uuid-123/retry'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ confirm: true }),
        }),
      );
    });

    it('throws RunActionConfirmationRequiredError on 409 confirmation_required', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve(confirmationRequiredPayload),
      });

      try {
        await retryRunAction('uuid-123');
        expect.fail('Should have thrown RunActionConfirmationRequiredError');
      } catch (err) {
        expect(err).toBeInstanceOf(RunActionConfirmationRequiredError);
        expect((err as RunActionConfirmationRequiredError).payload).toEqual(
          confirmationRequiredPayload,
        );
        expect((err as RunActionConfirmationRequiredError).message).toBe(
          'Retrying this phase can duplicate side effects. Confirm to continue.',
        );
      }
    });

    it('handles invalid response on 409 (non-confirmation_required JSON)', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'something_else' }),
      });

      await expect(retryRunAction('uuid-123')).rejects.toThrow('failed to retry run action: 409');
    });

    it('handles invalid response on 409 (malformed JSON)', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.reject(new Error('SyntaxError')),
      });

      await expect(retryRunAction('uuid-123')).rejects.toThrow('failed to retry run action: 409');
    });
  });

  describe('resumeRunAction', () => {
    it('handles success', async () => {
      const resumeSuccess: RunActionSuccessDto = { ...successPayload, action: 'resume' };
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(resumeSuccess),
      });

      const res = await resumeRunAction('uuid-123', { fromPhase: 'create-pr', confirm: true });
      expect(res).toEqual(resumeSuccess);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/runs/uuid-123/resume'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ fromPhase: 'create-pr', confirm: true }),
        }),
      );
    });

    it('throws RunActionConfirmationRequiredError on 409 confirmation_required', async () => {
      const resumeConf = { ...confirmationRequiredPayload, action: 'resume' as const };
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.resolve(resumeConf),
      });

      try {
        await resumeRunAction('uuid-123');
        expect.fail('Should have thrown RunActionConfirmationRequiredError');
      } catch (err) {
        expect(err).toBeInstanceOf(RunActionConfirmationRequiredError);
        expect((err as RunActionConfirmationRequiredError).payload).toEqual(resumeConf);
      }
    });

    it('handles invalid response on 409 (malformed JSON)', async () => {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 409,
        json: () => Promise.reject(new Error('SyntaxError')),
      });

      await expect(resumeRunAction('uuid-123')).rejects.toThrow('failed to resume run action: 409');
    });
  });
});
