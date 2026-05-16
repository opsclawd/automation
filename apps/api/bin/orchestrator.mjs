#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgDir = join(__dirname, '..');
const require = createRequire(join(pkgDir, 'package.json'));
const tsxPath = require.resolve('tsx/esm');
const cliPath = join(pkgDir, 'src', 'cli.ts');

try {
  execFileSync(
    'node',
    ['--conditions=development', '--import', tsxPath, cliPath, ...process.argv.slice(2)],
    {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env },
    },
  );
  process.exit(0);
} catch (e) {
  process.exit(e.status ?? (e.signal ? 1 : 2));
}
