import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('compose-plan-review forbidden-artifacts wiring', () => {
  it('threads configured forbidden artifact paths into deterministic plan review', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname ?? path.join(__dirname, '..'), '..', 'compose.ts'),
      'utf-8',
    );

    const checkFnMatch = composeSrc.match(
      /const planReviewCheckDeterministicPlan[\s\S]*?(?=const planReviewRunReview)/,
    );
    expect(checkFnMatch).toBeTruthy();
    expect(checkFnMatch![0]).toContain('createDeterministicPlanCheck({');
    expect(checkFnMatch![0]).toContain(
      'forbiddenArtifactPaths: config.validation.forbiddenArtifactPaths',
    );
  });
});
