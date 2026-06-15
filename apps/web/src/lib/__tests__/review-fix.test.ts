import { describe, it, expect } from 'vitest';
import { loopBadge, iterationChip, type LoopDto } from '../review-fix.js';

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
        fixInvocationId: 'f1',
        revalidationId: 're1',
        reviewArtifactPath: 'phases/review_fix/loop-1/review.md',
        fixArtifactPath: 'phases/review_fix/loop-1/fix.md',
        revalidateArtifactPath: 'phases/review_fix/loop-1/revalidate.md',
        startedAt: '2026-06-14T00:01:00.000Z',
        completedAt: '2026-06-14T00:05:00.000Z',
      },
    ],
  };
  expect(l.status).toBe('converged');
});
