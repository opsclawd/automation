import { test, expect } from '@playwright/test';

test('renders run list with seeded data', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await expect(page.getByText('R-001')).toBeVisible();
  await expect(page.getByText('R-002')).toBeVisible();
});

test('LiveLogViewer polls for log updates while run is running', async ({ page }) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

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

  // Browser-side route mocks exercise LiveLogViewer client polling behavior.
  // The initial SSR data is seeded into the API database by globalSetup;
  // route mocks override client-side polls for deterministic test assertions.
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
  const runId = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
  let callCount = 0;

  // Intercept: run starts as running, then becomes passed on 3rd poll.
  // Browser-side route mocks exercise LiveLogViewer client polling behavior.
  // callCount tracks client polls only.
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
  // Wait longer than one poll interval (2s) then assert no additional calls occurred.
  const callsBefore = callCount;
  await page.waitForTimeout(3000);
  expect(callCount).toBe(callsBefore);
});
