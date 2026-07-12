import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const TEST_AI_DIR = join(REPO_ROOT, 'test-results', 'e2e');
const DB_PATH = join(TEST_AI_DIR, 'orchestrator-test.sqlite');
const RUNS_DIR = TEST_AI_DIR;

export default async function globalSetup() {
  // Execute the CLI command to seed the database
  execSync(
    `npx tsx apps/api/src/cli.ts seed-test-db --db-path "${DB_PATH}" --runs-dir "${RUNS_DIR}"`,
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    },
  );
}
