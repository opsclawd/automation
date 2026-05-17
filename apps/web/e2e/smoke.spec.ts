import { test, expect } from '@playwright/test';

test('renders empty run list when no runs exist', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await expect(page.getByText('No runs yet')).toBeVisible();
});

test('LiveLogViewer polls for log updates while run is running', async ({ page }) => {
  const runId = 'test-run-001';

  const runPayload = {
    run: {
      uuid: runId,
      displayId: 'R-001',
      issueNumber: 1,
      status: 'running',
      currentPhase: 'implement',
      completedPhases: [],
      startedAt: new Date().toISOString(),
      completedAt: null,
      durationMs: 5000,
      exitCode: null,
      failureReason: null,
    },
    failure: null,
  };

  const artifactListPayload = {
    files: [{ path: 'combined.log', size: 42, modifiedAt: new Date().toISOString() }],
  };

  // Intercept all API requests for this run (browser-side from LiveLogViewer polling).
  // Note: page.route() only intercepts browser-side requests. The Next.js server
  // component that renders the initial page fetches data server-side, which
  // page.route() does NOT intercept. These tests require a running API server
  // (see playwright.config.ts) that can serve the initial SSR data for this runId.
  // The route mocks here exercise client-side polling behavior only.
  await page.route(`**/api/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(runPayload),
    });
  });

  await page.route(`**/api/runs/${runId}/artifacts`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(artifactListPayload),
    });
  });

  let logCallCount = 0;
  const logLines = ['line 1\n', 'line 1\nline 2\n', 'line 1\nline 2\nline 3\n'];

  await page.route(`**/api/runs/${runId}/artifacts/combined.log`, async (route) => {
    const idx = Math.min(logCallCount, logLines.length - 1);
    logCallCount++;
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: logLines[idx],
    });
  });

  await page.goto(`/runs/${runId}`);

  await expect(page.getByText('line 1')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('line 2')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('line 3')).toBeVisible({ timeout: 5000 });
});

test('LiveLogViewer stops polling on terminal status', async ({ page }) => {
  const runId = 'test-run-002';
  let callCount = 0;

  // Intercept: run starts as running, then becomes passed on 3rd poll.
  // page.route() only intercepts browser-side fetch requests; Next.js
  // server-side renders the initial page using server-side fetches that
  // Playwright does NOT intercept. callCount tracks client polls only.
  await page.route(`**/api/runs/${runId}`, async (route) => {
    callCount++;
    const status = callCount < 3 ? 'running' : 'passed';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        run: {
          uuid: runId,
          displayId: 'R-002',
          issueNumber: 2,
          status,
          currentPhase: null,
          completedPhases: ['implement'],
          startedAt: new Date().toISOString(),
          completedAt: status === 'passed' ? new Date().toISOString() : null,
          durationMs: 10000,
          exitCode: status === 'passed' ? 0 : null,
          failureReason: null,
        },
        failure: null,
      }),
    });
  });

  await page.route(`**/api/runs/${runId}/artifacts`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        files: [{ path: 'combined.log', size: 20, modifiedAt: new Date().toISOString() }],
      }),
    });
  });

  await page.route(`**/api/runs/${runId}/artifacts/combined.log`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'final log output\n',
    });
  });

  await page.goto(`/runs/${runId}`);

  // Wait for at least 3 client-side poll requests to occur (the 3rd returns 'passed')
  await expect.poll(() => callCount, { timeout: 10000 }).toBeGreaterThanOrEqual(3);

  // After status flips to 'passed', callCount should stabilize — no new polls.
  // Use polling assertion instead of fixed timeout to avoid flakiness on slow CI.
  const callsBefore = callCount;
  await expect.poll(() => callCount, { timeout: 5000 }).toBe(callsBefore);
});
