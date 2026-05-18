import { defineConfig } from '@playwright/test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const TEST_AI_DIR = join(REPO_ROOT, 'test-results', 'e2e');
const TEST_DB_PATH = join(TEST_AI_DIR, 'orchestrator-test.sqlite');

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4310' },
  globalSetup: './e2e/globalSetup.ts',
  webServer: [
    {
      // API server: uses --db-path and --runs-dir to point at the isolated
      // test directory so e2e seed data doesn't collide with development data.
      command: `pnpm --filter @ai-sdlc/api dev serve --port 4319 --db-path ${TEST_DB_PATH} --runs-dir ${TEST_AI_DIR}`,
      url: 'http://127.0.0.1:4319/api/runs',
      cwd: '../..',
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // Web server: Next.js dev server for the frontend.
      command: 'pnpm --filter @ai-sdlc/web dev',
      url: 'http://127.0.0.1:4310',
      cwd: '../..',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
