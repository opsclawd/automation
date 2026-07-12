import { test, expect } from '@playwright/test';

const HEALTHY_1_ID = 'f18c6375af9525d8fd93f40691bdd554d74c6ad67630ecd87cdac6fb08d7b45b';
const HEALTHY_2_ID = '34feb66c2f259a456d6b5134d520cd73d4935462a91636811e8fa1c6de07d345';

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
      repoId: HEALTHY_1_ID,
    },
    failure: null,
  };

  const artifactListPayload = {
    files: [{ path: 'combined.log', size: 42, modifiedAt: new Date().toISOString() }],
  };

  await page.route(`**/api/runs/${runId}*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_1_ID);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(runPayload),
    });
  });

  await page.route(`**/api/runs/${runId}/artifacts*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_1_ID);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(artifactListPayload),
    });
  });

  let logCallCount = 0;
  const logLines = ['line 1\n', 'line 1\nline 2\n', 'line 1\nline 2\nline 3\n'];

  await page.route(`**/api/runs/${runId}/artifacts/combined.log*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_1_ID);
    const idx = Math.min(logCallCount, logLines.length - 1);
    logCallCount++;
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: logLines[idx],
    });
  });

  await page.goto(`/repositories/${HEALTHY_1_ID}/runs/${runId}`);

  await expect(page.getByText('line 1')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('line 2')).toBeVisible({ timeout: 5000 });
  await expect(page.getByText('line 3')).toBeVisible({ timeout: 5000 });
});

test('LiveLogViewer stops polling on terminal status', async ({ page }) => {
  const runId = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
  let callCount = 0;

  await page.route(`**/api/runs/${runId}*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_2_ID);
    callCount++;
    const status = callCount < 3 ? 'running' : 'passed';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        run: {
          uuid: runId,
          displayId: 'R-002',
          issueNumber: 1,
          status,
          currentPhase: null,
          completedPhases: ['implement'],
          startedAt: new Date().toISOString(),
          completedAt: status === 'passed' ? new Date().toISOString() : null,
          durationMs: 10000,
          exitCode: status === 'passed' ? 0 : null,
          failureReason: null,
          repoId: HEALTHY_2_ID,
        },
        failure: null,
      }),
    });
  });

  await page.route(`**/api/runs/${runId}/artifacts*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_2_ID);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        files: [{ path: 'combined.log', size: 20, modifiedAt: new Date().toISOString() }],
      }),
    });
  });

  await page.route(`**/api/runs/${runId}/artifacts/combined.log*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_2_ID);
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: 'final log output\n',
    });
  });

  await page.goto(`/repositories/${HEALTHY_2_ID}/runs/${runId}`);

  await expect.poll(() => callCount, { timeout: 10000 }).toBeGreaterThanOrEqual(3);

  const callsBefore = callCount;
  await page.waitForTimeout(3000);
  expect(callCount).toBe(callsBefore);
});

test('pagination controls appear with >25 seeded runs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
  await expect(page.getByRole('link', { name: 'R-001' })).toBeVisible();
  await page.getByRole('link', { name: 'Next' }).click();
  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  await expect(page.getByText('R-026')).toBeVisible();
  await expect(page.getByText('R-030')).toBeVisible();
  await page.getByRole('link', { name: 'Previous' }).click();
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
});

test('run detail page switches between tabs', async ({ page }) => {
  const runId = 'c3d4e5f6-a7b8-9012-cdef-123456789012';
  await page.goto(`/repositories/${HEALTHY_1_ID}/runs/${runId}`);
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
  const runId = 'c3d4e5f6-a7b8-9012-cdef-123456789012';
  await page.route(`**/api/runs/${runId}/artifacts/README.md*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_1_ID);
    await route.fulfill({
      status: 200,
      contentType: 'text/markdown',
      body: '# Hello\n\nThis is **bold** markdown.',
    });
  });
  await page.route(`**/api/runs/${runId}/artifacts/data.json*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_1_ID);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ key: 'value', count: 42 }),
    });
  });
  await page.goto(`/repositories/${HEALTHY_1_ID}/runs/${runId}`);
  await page.getByRole('tab', { name: 'Artifacts' }).click();
  await page.getByRole('button', { name: 'README.md' }).click();
  await expect(page.getByText('This is bold markdown.')).toBeVisible();
  await page.getByRole('button', { name: 'README.md' }).click();
  await expect(page.getByText('This is bold markdown.')).not.toBeVisible();
  await page.getByRole('button', { name: 'data.json' }).click();
  await expect(page.getByText('"count": 42')).toBeVisible();
});

test('global_filters_reset_to_first_page_and_pagination_preserves_both_filters', async ({
  page,
}) => {
  // 1. Go to global page
  await page.goto('/');
  await expect(page.getByText('Page 1 of 2')).toBeVisible();

  // Go to next page
  await page.getByRole('link', { name: 'Next' }).click();
  await expect(page.getByText('Page 2 of 2')).toBeVisible();

  // Changing status filter should reset page to 1
  await page.locator('#filter-status').selectOption('passed');
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('page')).toBeNull();

  // Go back to All Statuses and Page 2
  await page.locator('#filter-status').selectOption('');
  await page.getByRole('link', { name: 'Next' }).click();
  await expect(page.getByText('Page 2 of 2')).toBeVisible();

  // Changing repository filter should reset page to 1
  await page.locator('#filter-repo').selectOption(HEALTHY_1_ID);
  await expect(page.getByText('Page 1 of 2')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('page')).toBeNull();

  // With repository filter selected, go to next page
  await page.getByRole('link', { name: 'Next' }).click();
  await expect(page.getByText('Page 2 of 2')).toBeVisible();
  const url = new URL(page.url());
  expect(url.pathname).toContain(`/repositories/${HEALTHY_1_ID}`);
  expect(url.searchParams.get('page')).toBe('2');
});

test('global_rows_show_the_owning_repository_and_unregistered_fallback', async ({ page }) => {
  await page.goto('/');
  // Assert column header Repository exists
  await expect(page.locator('th', { hasText: 'Repository' })).toBeVisible();

  // Row 1 (R-001) shows registered name and links to overview
  const link1 = page.getByRole('link', { name: 'owner/repo-healthy-1', exact: true });
  await expect(link1.first()).toBeVisible();
  await expect(link1.first()).toHaveAttribute('href', `/repositories/${HEALTHY_1_ID}`);

  // Row 2 (R-002) shows registered name and links to overview
  const link2 = page.getByRole('link', { name: 'owner/repo-healthy-2', exact: true });
  await expect(link2.first()).toBeVisible();
  await expect(link2.first()).toHaveAttribute('href', `/repositories/${HEALTHY_2_ID}`);

  // Go to page 2 to see the unregistered fallback run
  await page.getByRole('link', { name: 'Next' }).click();
  await expect(page.getByText('Unregistered repository (unregistered-repo-id)')).toBeVisible();
});

test('canonical_detail_links_and_existing_detail_tabs_keep_repository_context', async ({
  page,
}) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  // Intercept detail page API requests and verify repositoryId is present
  await page.route(`**/api/runs/${runId}*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_1_ID);
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
          repoId: HEALTHY_1_ID,
        },
        failure: null,
      }),
    });
  });

  await page.goto(`/repositories/${HEALTHY_1_ID}/runs/${runId}`);
  await expect(page.getByRole('heading', { name: 'R-001' })).toBeVisible();
});
