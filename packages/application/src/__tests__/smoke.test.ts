import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { packageName } from '../index.js';

describe('@ai-sdlc/application', () => {
  it('exports a package name', () => {
    expect(packageName).toBe('@ai-sdlc/application');
  });

  it('exposes the plan-review parse subpath with the .js export alias', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as {
      exports?: Record<string, { development?: string; types?: string; import?: string }>;
    };
    expect(pkg.exports?.['./plan-review/parse-plan-review-findings']).toMatchObject({
      development: './src/plan-review/parse-plan-review-findings.ts',
      types: './dist/plan-review/parse-plan-review-findings.d.ts',
      import: './dist/plan-review/parse-plan-review-findings.js',
    });
    expect(pkg.exports?.['./plan-review/parse-plan-review-findings.js']).toMatchObject({
      development: './src/plan-review/parse-plan-review-findings.ts',
      types: './dist/plan-review/parse-plan-review-findings.d.ts',
      import: './dist/plan-review/parse-plan-review-findings.js',
    });
  });
});
