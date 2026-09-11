import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { packageName } from '../index.js';

describe('@ai-sdlc/application', () => {
  it('exports a package name', () => {
    expect(packageName).toBe('@ai-sdlc/application');
  });

  it('exposes defined subpath exports', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
    ) as {
      exports?: Record<string, { development?: string; types?: string; import?: string }>;
    };
    expect(pkg.exports?.['./ports']).toMatchObject({
      development: './src/ports/index.ts',
      types: './dist/ports/index.d.ts',
      import: './dist/ports/index.js',
    });
    expect(pkg.exports?.['./review-state']).toMatchObject({
      development: './src/review-state/types.ts',
      types: './dist/review-state/types.d.ts',
      import: './dist/review-state/types.js',
    });
  });
});
