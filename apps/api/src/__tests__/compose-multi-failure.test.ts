import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('multi-failure revalidation collection', () => {
  it('collects all failing commands in review-fix runRevalidation', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname, '..', 'compose.ts'),
      'utf-8',
    );

    // Look for the ReviewFixLoop runRevalidation closure
    // It's around line 2600
    const reviewFixRevalMatch = composeSrc.match(/const reviewFixLoopInstance = new ReviewFixLoop\(\{[\s\S]*?runRevalidation: async \(ctx\) => \{([\s\S]*?)\},[\s\S]*?\}\);/);

    // Fallback if the above regex is too strict about newlines/spaces
    const reviewFixRevalBody = reviewFixRevalMatch ? reviewFixRevalMatch[1] :
      composeSrc.slice(composeSrc.indexOf('const runRevalidation = async (ctx: StepContext): Promise<RevalidationResult> => {'),
                       composeSrc.indexOf('await artifactStoreForRun(String(ctx.runId), ctx.cwd).write({'));

    expect(reviewFixRevalBody).toContain('.filter((c) => c.outcome !== \'passed\')');
    expect(reviewFixRevalBody).toContain('await Promise.all(');
    expect(reviewFixRevalBody).toContain('failingCommands.map');
    expect(reviewFixRevalBody).toContain('details.join(\'\\n\\n---\\n\\n\')');
    expect(reviewFixRevalBody).toContain('const failedCommand = failingCommands[0]');
  });

  it('collects all failing commands in implement-step runRevalidation', () => {
    const composeSrc = readFileSync(
      path.join(import.meta.dirname, '..', 'compose.ts'),
      'utf-8',
    );

    // Look for the ImplementStepLoop runRevalidation closure
    // It's around line 4280
    const implementRevalMatch = composeSrc.match(/implementStepLoop = new ImplementStepLoop\(\{[\s\S]*?runRevalidation: async \(ctx\) => \{([\s\S]*?)\},[\s\S]*?\}\);/);

    expect(implementRevalMatch).toBeTruthy();
    const implementRevalBody = implementRevalMatch![1];

    expect(implementRevalBody).toContain('.filter((c) => c.outcome !== \'passed\')');
    expect(implementRevalBody).toContain('await Promise.all(');
    expect(implementRevalBody).toContain('failingCommands.map');
    expect(implementRevalBody).toContain('details.join(\'\\n\\n---\\n\\n\')');
    expect(implementRevalBody).toContain('const failedCommand = failingCommands[0]');
  });
});
