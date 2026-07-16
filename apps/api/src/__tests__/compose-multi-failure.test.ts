import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Extracts the body of an arrow function starting at the `{` immediately
 * following `marker` by counting braces, rather than relying on a
 * non-greedy regex (which stops at the first nested `},` it finds, e.g.
 * the close of an inner object literal).
 */
function extractArrowFunctionBody(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) {
    throw new Error(`marker not found: ${marker}`);
  }
  const openBraceIndex = source.indexOf('{', markerIndex + marker.length);
  if (openBraceIndex === -1) {
    throw new Error(`no opening brace found after marker: ${marker}`);
  }
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(openBraceIndex + 1, i);
      }
    }
  }
  throw new Error(`no matching closing brace found for marker: ${marker}`);
}

describe('multi-failure revalidation collection', () => {
  it('collects all failing commands in review-fix runRevalidation', () => {
    const composeSrc = readFileSync(path.join(import.meta.dirname, '..', 'compose.ts'), 'utf-8');

    const reviewFixRevalBody = extractArrowFunctionBody(
      composeSrc,
      'const runRevalidation = async (ctx: StepContext): Promise<RevalidationResult> =>',
    );

    expect(reviewFixRevalBody).toContain(".filter((c) => c.outcome !== 'passed')");
    expect(reviewFixRevalBody).toContain('await Promise.all(');
    expect(reviewFixRevalBody).toContain('failingCommands.map');
    expect(reviewFixRevalBody).toContain("details.join('\\n\\n---\\n\\n')");
    expect(reviewFixRevalBody).toContain('const failedCommand = failingCommands[0]');
  });

  it('collects all failing commands in implement-step runRevalidation', () => {
    const composeSrc = readFileSync(path.join(import.meta.dirname, '..', 'compose.ts'), 'utf-8');

    const implementRevalBody = extractArrowFunctionBody(
      composeSrc,
      'runRevalidation: async (ctx) =>',
    );

    expect(implementRevalBody).toContain(".filter((c) => c.outcome !== 'passed')");
    expect(implementRevalBody).toContain('await Promise.all(');
    expect(implementRevalBody).toContain('failingCommands.map');
    expect(implementRevalBody).toContain("details.join('\\n\\n---\\n\\n')");
    expect(implementRevalBody).toContain('const failedCommand = failingCommands[0]');
  });
});
