import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4310' },
  globalSetup: './e2e/globalSetup.ts',
  webServer: [
    {
      command: 'pnpm --filter @ai-sdlc/api dev serve --port 4319',
      url: 'http://127.0.0.1:4319/api/runs',
      cwd: '../..',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @ai-sdlc/web dev',
      url: 'http://127.0.0.1:4310',
      cwd: '../..',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
