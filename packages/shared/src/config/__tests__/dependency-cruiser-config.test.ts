import { describe, it, expect } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import config from '../../../../../.dependency-cruiser.cjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../');

describe('dependency-cruiser configuration', () => {
  it('exclude.path regex matches Vite bundled-config transient timestamp artifacts', () => {

    const excludeRegex = new RegExp(config.options.exclude.path);

    const timestampFile =
      'packages/application/vitest.config.ts.timestamp-1787750154730-fdf72f8af3b238.mjs';
    const normalSourceFile = 'packages/application/src/index.ts';
    const nodeModulesFile = 'node_modules/vite/dist/node/index.js';

    expect(excludeRegex.test(timestampFile)).toBe(true);
    expect(excludeRegex.test(nodeModulesFile)).toBe(true);
    expect(excludeRegex.test(normalSourceFile)).toBe(false);
  });

  it('pnpm boundaries ignores transient timestamp artifact when present on disk', () => {
    const tempArtifactPath = resolve(
      REPO_ROOT,
      'packages/application/vitest.config.ts.timestamp-1787750154730-fdf72f8af3b238.mjs',
    );

    try {
      writeFileSync(tempArtifactPath, 'export default {};\n');

      const output = execSync('pnpm boundaries', {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
      });

      expect(output).not.toContain(
        'vitest.config.ts.timestamp-1787750154730-fdf72f8af3b238.mjs',
      );
    } finally {
      if (existsSync(tempArtifactPath)) {
        unlinkSync(tempArtifactPath);
      }
    }
  });
});
