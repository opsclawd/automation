import { test, expect } from '@playwright/test';

// Must match CANONICAL_PHASES in src/lib/timeline.ts — kept locally because
// e2e tests run in Node via Playwright and cannot import app source modules.
const CANONICAL_PHASES: readonly string[] = [
  'read_issue',
  'plan-design',
  'plan-write',
  'implement',
  'validate',
  'whole-pr-review',
  'fix-review',
  'compound',
  'create-pr',
];

test('Timeline tab renders all 9 canonical phases (AC8)', async ({ page }) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  await page.goto(`/runs/${runId}`);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByTestId('phase-timeline')).toBeVisible();
  for (const phase of CANONICAL_PHASES) {
    await expect(page.getByTestId(`phase-${phase}`)).toBeVisible();
  }
});

test('Running run shows started phases with correct statuses', async ({ page }) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  await page.goto(`/runs/${runId}`);
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
  await page.goto(`/runs/${runId}`);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByTestId('timeline-loading')).toBeHidden();
  await expect(page.getByTestId('phase-validate')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('phase-validate-failure')).toContainText('something went wrong');
  for (const phase of ['whole-pr-review', 'fix-review', 'compound', 'create-pr']) {
    await expect(page.getByTestId(`phase-${phase}`)).toHaveAttribute('data-status', 'pending');
  }
});

test('Duration is displayed for completed phases', async ({ page }) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  await page.goto(`/runs/${runId}`);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  const readIssue = page.getByTestId('phase-read_issue');
  await expect(readIssue).toBeVisible();
  await expect(readIssue.locator('text=/\\d+(ms|s)/')).toBeVisible();
});
