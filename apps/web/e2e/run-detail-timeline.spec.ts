import { test, expect } from '@playwright/test';

const CANONICAL_PHASES = [
  'read_issue',
  'plan-design',
  'plan-write',
  'implement',
  'validate',
  'review',
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
  await expect(page.getByTestId('phase-validate')).toHaveAttribute('data-status', 'failed');
  await expect(page.getByTestId('phase-validate-failure')).toContainText('something went wrong');
});

test('Duration is displayed for completed phases', async ({ page }) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  await page.goto(`/runs/${runId}`);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  const readIssue = page.getByTestId('phase-read_issue');
  await expect(readIssue).toBeVisible();
  await expect(readIssue.locator('text=/\\d+(ms|s)/')).toBeVisible();
});
