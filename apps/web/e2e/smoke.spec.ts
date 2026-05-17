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

test('pagination controls appear with >25 seeded runs', async ({ page }) => {
  const runs = Array.from({ length: 30 }, (_, i) => ({
    uuid: `paging-test-${i.toString().padStart(3, '0')}`,
    displayId: `R-P${(i + 1).toString().padStart(3, '0')}`,
    issueNumber: i + 100,
    status: 'passed',
    currentPhase: null,
    completedPhases: [],
    startedAt: new Date(Date.now() - i * 60000).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 5000,
    exitCode: 0,
    failureReason: null,
  }));
  await page.route('**/api/runs?limit=25&offset=0', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        runs: runs.slice(0, 25),
        total: 30,
        limit: 25,
        offset: 0,
      }),
    });
  });
  await page.route('**/api/runs?limit=25&offset=25', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        runs: runs.slice(25, 30),
        total: 30,
        limit: 25,
        offset: 25,
      }),
    });
  });
  await page.goto('/');
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
  await expect(page.getByText('R-P001')).toBeVisible();
  await page.getByRole('link', { name: 'Next' }).click();
  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  await expect(page.getByText('R-P026')).toBeVisible();
  await expect(page.getByText('R-P030')).toBeVisible();
});

test('run detail page switches between tabs', async ({ page }) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  await page.route(`**/api/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        run: {
          uuid: runId,
          displayId: 'R-001',
          issueNumber: 1,
          status: 'passed',
          currentPhase: null,
          completedPhases: ['implement'],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 5000,
          exitCode: 0,
          failureReason: null,
        },
        failure: {
          kind: 'test_failure',
          message: 'something went wrong',
          phase: 'implement',
          exitCode: 1,
          suggestedAction: 'fix the test',
          artifacts: ['test.log'],
        },
      }),
    });
  });
  await page.route(`**/api/runs/${runId}/artifacts`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        files: [
          { path: 'combined.log', size: 20, modifiedAt: new Date().toISOString() },
          { path: 'output.json', size: 100, modifiedAt: new Date().toISOString() },
        ],
      }),
    });
  });
  await page.route(`**/api/runs/${runId}/artifacts/combined.log`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'test log output\n',
    });
  });
  await page.goto(`/runs/${runId}`);
  await expect(page.getByRole('tab', { name: 'Logs' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Artifacts' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Failure' })).toBeVisible();
  await page.getByRole('tab', { name: 'Artifacts' }).click();
  await expect(page.getByText('combined.log')).toBeVisible();
  await expect(page.getByText('output.json')).toBeVisible();
  await page.getByRole('tab', { name: 'Failure' }).click();
  await expect(page.getByText('something went wrong')).toBeVisible();
});

test('clicking a .md artifact renders markdown in-page', async ({ page }) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  await page.route(`**/api/runs/${runId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        run: {
          uuid: runId,
          displayId: 'R-001',
          issueNumber: 1,
          status: 'passed',
          currentPhase: null,
          completedPhases: [],
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          durationMs: 5000,
          exitCode: 0,
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
        files: [
          { path: 'README.md', size: 50, modifiedAt: new Date().toISOString() },
          { path: 'data.json', size: 80, modifiedAt: new Date().toISOString() },
        ],
      }),
    });
  });
  await page.route(`**/api/runs/${runId}/artifacts/README.md`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/markdown',
      body: '# Hello\n\nThis is **bold** markdown.',
    });
  });
  await page.route(`**/api/runs/${runId}/artifacts/data.json`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ key: 'value', count: 42 }),
    });
  });
  await page.goto(`/runs/${runId}`);
  await page.getByRole('tab', { name: 'Artifacts' }).click();
  await page.getByText('README.md').click();
  await expect(page.getByText('This is bold markdown.')).toBeVisible();
  await page.getByText('data.json').click();
  await expect(page.getByText('"count": 42')).toBeVisible();
});
