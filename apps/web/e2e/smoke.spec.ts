import { test, expect } from '@playwright/test';

test('renders empty run list when no runs exist', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await expect(page.getByText('No runs yet')).toBeVisible();
});

test('LiveLogViewer polls for log updates while run is running', async ({ page }) => {
  const runId = 'test-run-001';

  // Intercept: initial page SSR data
  await page.route(`**/api/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
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
      }),
    });
  });

  // Intercept: artifact list
  await page.route(`**/api/runs/${runId}/artifacts`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        files: [{ path: 'combined.log', size: 42, modifiedAt: new Date().toISOString() }],
      }),
    });
  });

  let logCallCount = 0;
  const logLines = ['line 1\n', 'line 1\nline 2\n', 'line 1\nline 2\nline 3\n'];

  // Intercept: combined.log — returns progressively more content
  await page.route(`**/api/runs/${runId}/artifacts/combined.log`, async (route) => {
    const idx = Math.min(logCallCount, logLines.length - 1);
    logCallCount++;
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: logLines[idx],
    });
  });

  // Navigate to the run detail page
  await page.goto(`/runs/${runId}`);

  // Initial render should show first log line
  await expect(page.getByText('line 1')).toBeVisible({ timeout: 5000 });

  // After polling, new content should appear
  await expect(page.getByText('line 2')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('line 3')).toBeVisible({ timeout: 5000 });
});

test('LiveLogViewer stops polling on terminal status', async ({ page }) => {
  const runId = 'test-run-002';
  let callCount = 0;

  // Intercept: run starts as running, then becomes passed on 3rd poll
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

  // Wait for "passed" status badge to appear, confirming polling stopped
  await expect(page.getByText('passed', { exact: true })).toBeVisible({ timeout: 10000 });

  // Reset callCount tracker; after status is terminal, no more polls should happen
  const callsBefore = callCount;
  await page.waitForTimeout(3000);

  // callCount should not have increased significantly (at most 1 in-flight request)
  expect(callCount).toBeLessThanOrEqual(callsBefore + 1);
});
