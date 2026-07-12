import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loopBadge, iterationChip, type LoopDto } from '../review-fix.js';
import { listReviewFix } from '../api-client';

describe('loopBadge', () => {
  it('maps running to blue', () => {
    expect(loopBadge('running')).toEqual({ label: 'Running', color: 'blue' });
  });
  it('maps converged to green', () => {
    expect(loopBadge('converged')).toEqual({ label: 'Converged', color: 'green' });
  });
  it('maps exhausted to red', () => {
    expect(loopBadge('exhausted')).toEqual({ label: 'Exhausted', color: 'red' });
  });
  it('maps failed to red', () => {
    expect(loopBadge('failed')).toEqual({ label: 'Failed', color: 'red' });
  });
  it('maps converged_with_notes to amber with "Notes" label (#627)', () => {
    expect(loopBadge('converged_with_notes')).toEqual({
      label: 'Converged (Notes)',
      color: 'amber',
    });
  });
});

describe('iterationChip', () => {
  it('maps resolved to green', () => {
    expect(iterationChip('resolved')).toEqual({ label: 'resolved', color: 'green' });
  });
  it('maps fixed to blue', () => {
    expect(iterationChip('fixed')).toEqual({ label: 'fixed', color: 'blue' });
  });
  it('maps unresolved to amber', () => {
    expect(iterationChip('unresolved')).toEqual({ label: 'unresolved', color: 'amber' });
  });
  it('maps failed to red', () => {
    expect(iterationChip('failed')).toEqual({ label: 'failed', color: 'red' });
  });
  it('maps null to slate (open iteration)', () => {
    expect(iterationChip(null)).toEqual({ label: 'running', color: 'slate' });
  });
});

describe('listReviewFix', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        loops: [
          {
            id: 'l1',
            phaseId: 'whole-pr-review',
            type: 'review-fix',
            status: 'converged',
            maxIterations: 3,
            startedAt: '2026-06-14T00:00:00.000Z',
            completedAt: '2026-06-14T00:05:00.000Z',
            iterations: [],
          },
        ],
      }),
    } as Response);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls the correct URL and unwraps .loops from the response', async () => {
    const loops = await listReviewFix('repo-123', 'abc-123');
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/runs/abc-123/review-fix'), {
      cache: 'no-store',
    });
    expect(loops).toHaveLength(1);
    expect(loops[0]!.id).toBe('l1');
  });

  it('throws on non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
    } as Response);
    await expect(listReviewFix('repo-123', 'abc-123')).rejects.toThrow(
      'failed to load review-fix: 500',
    );
  });
});

it('LoopDto type compiles', () => {
  const l: LoopDto = {
    id: 'l1',
    phaseId: 'whole-pr-review',
    type: 'review-fix',
    status: 'converged',
    maxIterations: 3,
    startedAt: '2026-06-14T00:00:00.000Z',
    completedAt: null,
    iterations: [
      {
        index: 1,
        outcome: 'resolved',
        reviewInvocationId: 'r1',
        qualityReviewInvocationId: null,
        fixInvocationId: 'f1',
        revalidationId: 're1',
        reviewArtifactPath: 'review-fix/l1/review/whole-pr-review/iter-1/code-review.md',
        fixArtifactPath: 'review-fix/l1/fix/whole-pr-review/iter-1/result.json',
        revalidateArtifactPath: 'revalidate/l1/whole-pr-review/iter-1/validation-result.json',
        startedAt: '2026-06-14T00:01:00.000Z',
        completedAt: '2026-06-14T00:05:00.000Z',
      },
    ],
  };
  expect(l.status).toBe('converged');
});
