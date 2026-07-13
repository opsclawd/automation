import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlanReviewLoop } from '../plan-review-loop.js';
import type { PlanReviewLoopDeps, PlanReviewLoopInput } from '../types.js';
import { RunId, PhaseName } from '@ai-sdlc/domain';

describe('PlanReviewLoop Blast Radius Check', () => {
  let deps: PlanReviewLoopDeps;
  const runId = RunId('test-run');
  const phaseId = PhaseName('plan-review');

  beforeEach(() => {
    deps = {
      runReview: vi.fn(),
      runFix: vi.fn(),
      checkManifestSync: vi.fn().mockResolvedValue(null),
      checkBlastRadius: vi.fn().mockResolvedValue(null),
      computeLastFixDiffCitations: vi.fn().mockReturnValue([]),
      loops: {
        insert: vi.fn(),
        update: vi.fn(),
      } as any,
      events: {
        publish: vi.fn(),
      } as any,
      now: () => new Date(),
      idFactory: () => 'test-id',
    };
  });

  it('triggers a deterministic fix iteration when checkBlastRadius fails', async () => {
    const loop = new PlanReviewLoop(deps);
    const input: PlanReviewLoopInput = {
      runId,
      phaseId,
      repoId: 'test-repo',
      cwd: '/test/cwd',
      maxIterations: 5,
    };

    // First call to checkBlastRadius fails
    vi.mocked(deps.checkBlastRadius)
      .mockResolvedValueOnce('Blast radius violation: symbol "foo" in out-of-scope file "bar.ts"')
      .mockResolvedValueOnce(null); // Second call (after fix) succeeds

    vi.mocked(deps.runFix).mockResolvedValue({
      invocationId: 'fix-1',
      agentOutcome: 'success',
      verdict: 'done_with_fixes',
      headBeforeFix: 'sha-0',
    });

    vi.mocked(deps.runReview).mockResolvedValue({
      invocationId: 'review-1',
      agentOutcome: 'success',
      verdict: 'pass',
    });

    const result = await loop.execute(input);

    expect(result.outcome).toBe('success');
    // 1st call: top of loop (fails)
    // 2nd call: inside checkAndFixManifest loop after fix (succeeds)
    // 3rd call: finalSyncResult inside execute pass branch (succeeds)
    // 4th call: top of loop again after continue (succeeds)
    expect(deps.checkBlastRadius).toHaveBeenCalledTimes(4);
    expect(deps.runFix).toHaveBeenCalledWith(
      expect.objectContaining({ iterationIndex: 1 }),
      expect.objectContaining({
        manifestMismatch: 'Blast radius violation: symbol "foo" in out-of-scope file "bar.ts"',
      }),
    );
    // 1st call: iteration 2 (intermediate_delta)
    // 2nd call: iteration 3 (final_full)
    expect(deps.runReview).toHaveBeenCalledTimes(2);
    expect(deps.events.publish).toHaveBeenCalledWith(
      runId,
      expect.objectContaining({
        type: 'deterministic_fix',
        message: expect.stringContaining('Blast radius violation'),
      }),
    );
  });
});
