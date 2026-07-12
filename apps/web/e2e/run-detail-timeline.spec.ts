import { test, expect } from '@playwright/test';

const HEALTHY_1_ID = 'f18c6375af9525d8fd93f40691bdd554d74c6ad67630ecd87cdac6fb08d7b45b';

const CANONICAL_PHASES: readonly string[] = [
  'read_issue',
  'plan-design',
  'plan-write',
  'implement',
  'validate',
  'fix-validate',
  'review-fix',
  'compound',
  'create-pr',
];

test('Timeline tab renders all 9 canonical phases (M8-06)', async ({ page }) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  // Intercept listRunEvents
  await page.route(`**/api/runs/${runId}/events*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_1_ID);
    if (url.pathname.endsWith('/events/stream')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/repositories/${HEALTHY_1_ID}/runs/${runId}`);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByTestId('phase-timeline')).toBeVisible();
  for (const phase of CANONICAL_PHASES) {
    await expect(page.getByTestId(`phase-${phase}`)).toBeVisible();
  }
});

test('Running run shows started phases with correct statuses', async ({ page }) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  await page.route(`**/api/runs/${runId}/events*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_1_ID);
    if (url.pathname.endsWith('/events/stream')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/repositories/${HEALTHY_1_ID}/runs/${runId}`);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByTestId('timeline-loading')).toBeHidden();
  await expect(page.getByTestId('phase-read_issue')).toHaveAttribute('data-status', 'passed');
  await expect(page.getByTestId('phase-plan-design')).toHaveAttribute('data-status', 'passed');
  await expect(page.getByTestId('phase-plan-write')).toHaveAttribute('data-status', 'passed');
  await expect(page.getByTestId('phase-implement')).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('phase-validate')).toHaveAttribute('data-status', 'pending');
});

test('Failed run shows failed phase with failure message (AC9)', async ({ page }) => {
  const runId = 'c3d4e5f6-a7b8-9012-cdef-123456789012';

  await page.route(`**/api/runs/${runId}/events*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_1_ID);
    if (url.pathname.endsWith('/events/stream')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/repositories/${HEALTHY_1_ID}/runs/${runId}`);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByTestId('timeline-loading')).toBeHidden();
  await expect(page.getByTestId('phase-validate')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('phase-validate-failure')).toContainText('something went wrong');
  for (const phase of ['review-fix', 'compound', 'create-pr']) {
    await expect(page.getByTestId(`phase-${phase}`)).toHaveAttribute('data-status', 'pending');
  }
});

test('Duration is displayed for completed phases', async ({ page }) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  await page.route(`**/api/runs/${runId}/events*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_1_ID);
    if (url.pathname.endsWith('/events/stream')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: '',
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`/repositories/${HEALTHY_1_ID}/runs/${runId}`);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  const readIssue = page.getByTestId('phase-read_issue');
  await expect(readIssue).toBeVisible();
  await expect(readIssue.locator('text=/\\d+(ms|s)/')).toBeVisible();
});
