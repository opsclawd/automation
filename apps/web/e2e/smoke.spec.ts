import { test, expect } from '@playwright/test';
test('renders empty run list when no runs exist', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await expect(page.getByText('No runs yet')).toBeVisible();
});
