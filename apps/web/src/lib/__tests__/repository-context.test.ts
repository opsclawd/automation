import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getRun,
  listArtifacts,
  getArtifact,
  listRunEvents,
  listValidation,
  listPrReview,
  listReviewFix,
  cancelRunAction,
  retryRunAction,
  resumeRunAction,
  getStatusMetrics,
} from '../api-client';
import { getRepositoryAvailability } from '../repository-availability';
import type { RepositoryDto } from '../api-client';

describe('Repository context and availability', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('appends_repository_context_to_every_run_resource_url', async () => {
    // getRun
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ run: {}, failure: null }),
    });
    await getRun('repo-123', 'run-abc');
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/runs\/run-abc\?(.*&)?repositoryId=repo-123($|&)/),
      expect.any(Object),
    );

    // listArtifacts
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ files: [] }),
    });
    await listArtifacts('repo-123', 'run-abc');
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/runs\/run-abc\/artifacts\?(.*&)?repositoryId=repo-123($|&)/),
      expect.any(Object),
    );

    // getArtifact
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(''),
    });
    await getArtifact('repo-123', 'run-abc', 'log.txt');
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(
        /\/api\/runs\/run-abc\/artifacts\/log.txt\?(.*&)?repositoryId=repo-123($|&)/,
      ),
      expect.any(Object),
    );

    // listValidation
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ validationRuns: [] }),
    });
    await listValidation('repo-123', 'run-abc');
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/runs\/run-abc\/validation\?(.*&)?repositoryId=repo-123($|&)/),
      expect.any(Object),
    );

    // listPrReview
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ comments: [], pollAttempts: [] }),
    });
    await listPrReview('repo-123', 'run-abc');
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/runs\/run-abc\/pr-review\?(.*&)?repositoryId=repo-123($|&)/),
      expect.any(Object),
    );

    // listReviewFix
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ loops: [] }),
    });
    await listReviewFix('repo-123', 'run-abc');
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/runs\/run-abc\/review-fix\?(.*&)?repositoryId=repo-123($|&)/),
      expect.any(Object),
    );

    // cancelRunAction
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });
    await cancelRunAction('repo-123', 'run-abc');
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/runs\/run-abc\/cancel\?(.*&)?repositoryId=repo-123($|&)/),
      expect.any(Object),
    );

    // retryRunAction
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });
    await retryRunAction('repo-123', 'run-abc');
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/runs\/run-abc\/retry\?(.*&)?repositoryId=repo-123($|&)/),
      expect.any(Object),
    );

    // resumeRunAction
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    });
    await resumeRunAction('repo-123', 'run-abc');
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/runs\/run-abc\/resume\?(.*&)?repositoryId=repo-123($|&)/),
      expect.any(Object),
    );
  });

  it('preserves_repository_context_and_since_cursor_for_event_backfill_and_sse', async () => {
    // listRunEvents (backfill) without since
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ events: [] }),
    });
    await listRunEvents('repo-123', 'run-abc');
    expect(globalThis.fetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/runs\/run-abc\/events\?(.*&)?repositoryId=repo-123($|&)/),
      expect.any(Object),
    );

    // listRunEvents (backfill) with since
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ events: [] }),
    });
    await listRunEvents('repo-123', 'run-abc', '2026-07-12');
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(call).toBeDefined();
    const lastUrl = call![0] as string;
    const urlObj = new URL(lastUrl, 'http://localhost');
    expect(urlObj.searchParams.get('repositoryId')).toBe('repo-123');
    expect(urlObj.searchParams.get('since')).toBe('2026-07-12');
  });

  it('does_not_fallback_when_canonical_detail_context_returns_404', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 404,
    });
    await expect(getRun('repo-123', 'run-abc')).rejects.toThrow('failed to load run: 404');
  });

  it('maps_repository_availability_to_the_strict_ui_eligibility_policy', () => {
    const baseRepo: RepositoryDto = {
      id: 'repo-1',
      fullName: 'owner/repo',
      owner: 'owner',
      name: 'repo',
      localBasePath: '/path',
      defaultBranch: 'main',
      remoteUrl: 'url',
      enabled: true,
      healthStatus: 'healthy',
      healthError: null,
      lastHealthCheckAt: '2026-07-12',
      configMetadata: '{}',
      createdAt: '2026-07-12',
      updatedAt: '2026-07-12',
    };

    // healthy
    expect(getRepositoryAvailability(baseRepo)).toEqual({
      label: 'Healthy',
      reason: null,
      eligible: true,
    });

    // disabled
    expect(getRepositoryAvailability({ ...baseRepo, enabled: false })).toEqual({
      label: 'Disabled',
      reason: 'Repository is disabled',
      eligible: false,
    });

    // unknown
    expect(
      getRepositoryAvailability({
        ...baseRepo,
        healthStatus: 'unknown',
        healthError: 'check pending',
      }),
    ).toEqual({
      label: 'Unknown',
      reason: 'check pending',
      eligible: false,
    });

    // degraded
    expect(
      getRepositoryAvailability({
        ...baseRepo,
        healthStatus: 'degraded',
        healthError: 'linter failed',
      }),
    ).toEqual({
      label: 'Degraded',
      reason: 'linter failed',
      eligible: false,
    });

    // unreachable
    expect(
      getRepositoryAvailability({
        ...baseRepo,
        healthStatus: 'unreachable',
        healthError: 'auth error',
      }),
    ).toEqual({
      label: 'Unreachable',
      reason: 'auth error',
      eligible: false,
    });
  });

  it('starts all eight metric requests in parallel', async () => {
    let activeRequests = 0;
    let maxParallel = 0;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (_url) => {
      activeRequests++;
      maxParallel = Math.max(maxParallel, activeRequests);
      // defer resolution
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeRequests--;
      return {
        ok: true,
        json: () => Promise.resolve({ runs: [], total: 42, limit: 1, offset: 0 }),
      };
    });

    const metrics = await getStatusMetrics('repo-123');
    expect(maxParallel).toBe(8);
    expect(metrics).toEqual({
      queued: 42,
      running: 42,
      waiting: 42,
      passed: 42,
      failed: 42,
      cancelled: 42,
      blocked: 42,
      needs_human_review: 42,
    });
  });
});
