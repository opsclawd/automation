import { defineConfig } from '@playwright/test';
// M1 smoke test is manual-only: no `webServer` block, so you must start
// `pnpm --filter @ai-sdlc/web dev` (and the API) in another terminal
// before running `pnpm --filter @ai-sdlc/web e2e`.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4310' },
});
