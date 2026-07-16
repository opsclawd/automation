import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Both runRevalidation closures share these unique start markers followed
// eventually by a matching unique marker that appears exactly once right
// after the closure ends. Slicing between those two indices (rather than a
// non-greedy regex spanning `[\s\S]*?`) avoids matching the wrong occurrence
// or truncating at the first nested `},` inside the closure body (e.g. the
// `env: {...}` object literal), both of which caused false negatives here
// once task-manifest-derived validation commands were folded in ahead of
// the shared filter/collect logic.
function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`start marker not found: ${startMarker}`);
  }
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`end marker not found after start: ${endMarker}`);
  }
  return source.slice(start + startMarker.length, end);
}

describe('multi-failure revalidation collection', () => {
  it('collects all failing commands in review-fix runRevalidation', () => {
    const composeSrc = readFileSync(path.join(import.meta.dirname, '..', 'compose.ts'), 'utf-8');

    const reviewFixRevalBody = sliceBetween(
      composeSrc,
      'const runRevalidation = async (ctx: StepContext): Promise<RevalidationResult> => {',
      '\n      // Wrap the in-memory bus so loop events survive process restarts.',
    );

    expect(reviewFixRevalBody).toContain(".filter((c) => c.outcome !== 'passed')");
    expect(reviewFixRevalBody).toContain('await Promise.all(');
    expect(reviewFixRevalBody).toContain('failingCommands.map');
    expect(reviewFixRevalBody).toContain("details.join('\\n\\n---\\n\\n')");
    expect(reviewFixRevalBody).toContain('const failedCommand = failingCommands[0]');
  });

  it('collects all failing commands in implement-step runRevalidation', () => {
    const composeSrc = readFileSync(path.join(import.meta.dirname, '..', 'compose.ts'), 'utf-8');

    const implementRevalBody = sliceBetween(
      composeSrc,
      'runRevalidation: async (ctx) => {',
      '\n        ...(runArbiter ? { runArbiter } : {}),',
    );

    expect(implementRevalBody).toContain(".filter((c) => c.outcome !== 'passed')");
    expect(implementRevalBody).toContain('await Promise.all(');
    expect(implementRevalBody).toContain('failingCommands.map');
    expect(implementRevalBody).toContain("details.join('\\n\\n---\\n\\n')");
    expect(implementRevalBody).toContain('const failedCommand = failingCommands[0]');
  });
});
