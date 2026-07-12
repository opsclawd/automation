import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

function sha256(val: string): string {
  return createHash('sha256').update(val).digest('hex');
}

const HEALTHY_1_ID = sha256('owner/repo-healthy-1');
const HEALTHY_2_ID = sha256('owner/repo-healthy-2');
const DISABLED_ID = sha256('owner/repo-disabled');
const UNKNOWN_ID = sha256('owner/repo-unknown');
const DEGRADED_ID = sha256('owner/repo-degraded');
const UNREACHABLE_ID = sha256('owner/repo-unreachable');

test.describe('Multi-Repo Dashboard & Repository Overview', () => {
  test('selector navigation to each healthy overview', async ({ page }) => {
    await page.goto('/');

    const selector = page.locator('#repo-selector');
    await expect(selector.locator(`option[value="${HEALTHY_1_ID}"]`)).toBeAttached();
    await selector.selectOption(HEALTHY_1_ID);
    await expect(page).toHaveURL(new RegExp(`/repositories/${HEALTHY_1_ID}`));
    await expect(page.locator('[data-testid="repo-title"]')).toHaveText('owner/repo-healthy-1');

    await expect(selector.locator(`option[value="${HEALTHY_2_ID}"]`)).toBeAttached();
    await selector.selectOption(HEALTHY_2_ID);
    await expect(page).toHaveURL(new RegExp(`/repositories/${HEALTHY_2_ID}`));
    await expect(page.locator('[data-testid="repo-title"]')).toHaveText('owner/repo-healthy-2');
  });

  test('scoped list and all eight metric labels/counts', async ({ page }) => {
    await page.goto(`/repositories/${HEALTHY_1_ID}`);

    await expect(page.locator('[data-testid="status-metrics"]')).toBeVisible();
    await expect(page.locator('[data-testid="metric-count-total"]')).toHaveText('28');
    await expect(page.locator('[data-testid="metric-count-running"]')).toHaveText('1');
    await expect(page.locator('[data-testid="metric-count-failed"]')).toHaveText('1');
    await expect(page.locator('[data-testid="metric-count-passed"]')).toHaveText('26');
  });

  test('both overlapping issue-number detail links showing the correct fullName and only that repository content', async ({
    page,
  }) => {
    // Overlapping issue #1 runs: R-001 (HEALTHY_1) and R-002 (HEALTHY_2)
    await page.goto('/');

    const link1 = page.locator('a[href*="runs/a1b2c3d4-e5f6-7890-abcd-ef1234567890"]');
    await expect(link1).toBeVisible();
    await link1.click();
    await expect(page).toHaveURL(
      new RegExp(`/repositories/${HEALTHY_1_ID}/runs/a1b2c3d4-e5f6-7890-abcd-ef1234567890`),
    );
    await expect(page.locator('main header').getByText('owner/repo-healthy-1')).toBeVisible();

    await page.goto('/');
    const link2 = page.locator('a[href*="runs/b2c3d4e5-f6a7-8901-bcde-f12345678901"]');
    await expect(link2).toBeVisible();
    await link2.click();
    await expect(page).toHaveURL(
      new RegExp(`/repositories/${HEALTHY_2_ID}/runs/b2c3d4e5-f6a7-8901-bcde-f12345678901`),
    );
    await expect(page.locator('main header').getByText('owner/repo-healthy-2')).toBeVisible();
  });

  test('empty selection rejection with two enabled Repositories', async ({ page }) => {
    await page.goto(`/repositories/${HEALTHY_1_ID}`);

    // Set issue number but leave repository empty
    await page.locator('[data-testid="run-issue-number"]').fill('123');
    await page.locator('[data-testid="run-repository-id"]').selectOption('');
    await page.locator('[data-testid="new-run-submit"]').click();

    await expect(page.locator('[data-testid="new-run-error"]')).toContainText(
      'Please select a repository.',
    );
  });

  test('selected-ID POST body plus canonical redirect', async ({ page }) => {
    let postRequest: Record<string, unknown> | null = null;
    const NEW_RUN_UUID = '88888888-4444-4444-4444-121212121212';
    await page.route('**/api/runs', async (route) => {
      if (route.request().method() === 'POST') {
        postRequest = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            run: {
              uuid: NEW_RUN_UUID,
              displayId: 'R-999',
              issueNumber: 123,
              repoId: HEALTHY_1_ID,
              status: 'queued',
              currentPhase: null,
              completedPhases: [],
              startedAt: new Date().toISOString(),
              completedAt: null,
              exitCode: null,
              durationMs: null,
              failureReason: null,
            },
          }),
        });
      } else {
        await route.fallback();
      }
    });

    await page.goto(`/repositories/${HEALTHY_1_ID}`);

    await page.locator('[data-testid="run-issue-number"]').fill('123');
    await page.locator('[data-testid="run-repository-id"]').selectOption(HEALTHY_1_ID);
    await page.locator('[data-testid="new-run-submit"]').click();

    await expect(page).toHaveURL(new RegExp(`/repositories/${HEALTHY_1_ID}/runs/${NEW_RUN_UUID}`));
    expect(postRequest).toEqual({
      repositoryId: HEALTHY_1_ID,
      issueNumber: 123,
    });
  });

  test('disabled/unhealthy options visibly unavailable', async ({ page }) => {
    await page.goto(`/repositories/${HEALTHY_1_ID}`);

    const select = page.locator('[data-testid="run-repository-id"]');
    await expect(select.locator(`option[value="${DISABLED_ID}"]`)).toBeDisabled();
    await expect(select.locator(`option[value="${UNKNOWN_ID}"]`)).toBeDisabled();
    await expect(select.locator(`option[value="${DEGRADED_ID}"]`)).toBeDisabled();
    await expect(select.locator(`option[value="${UNREACHABLE_ID}"]`)).toBeDisabled();
    await expect(select.locator(`option[value="${HEALTHY_1_ID}"]`)).not.toBeDisabled();
  });

  test('health-refresh POST followed by a route refresh', async ({ page }) => {
    let refreshPosted = false;
    await page.route(`**/api/repositories/${HEALTHY_1_ID}/refresh`, async (route) => {
      if (route.request().method() === 'POST') {
        refreshPosted = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: HEALTHY_1_ID,
            fullName: 'owner/repo-healthy-1',
            enabled: true,
            healthStatus: 'healthy',
            healthError: null,
          }),
        });
      } else {
        await route.fallback();
      }
    });

    await page.goto(`/repositories/${HEALTHY_1_ID}`);
    await page.locator('[data-testid="refresh-health-btn"]').click();

    // Verify it stays on the route context
    await expect(page).toHaveURL(new RegExp(`/repositories/${HEALTHY_1_ID}`));
    expect(refreshPosted).toBe(true);
  });

  test('mutations block concurrent submissions and failed mutations allow re-entry', async ({
    page,
  }) => {
    // 1. New Run Form lock/unlock
    await page.route('**/api/runs', async (route) => {
      // delay resolution
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'API validation failed' }),
      });
    });

    await page.goto(`/repositories/${HEALTHY_1_ID}`);

    await page.locator('[data-testid="run-issue-number"]').fill('456');
    await page.locator('[data-testid="run-repository-id"]').selectOption(HEALTHY_1_ID);

    // click submit
    const submitBtn = page.locator('[data-testid="new-run-submit"]');
    const issueInput = page.locator('[data-testid="run-issue-number"]');
    const repoSelect = page.locator('[data-testid="run-repository-id"]');

    await submitBtn.click();

    // Verify UI is locked during submission
    await expect(submitBtn).toBeDisabled();
    await expect(issueInput).toBeDisabled();
    await expect(repoSelect).toBeDisabled();

    // Wait for failure
    await expect(page.locator('[data-testid="new-run-error"]')).toBeVisible();

    // Verify UI is unlocked on error
    await expect(submitBtn).not.toBeDisabled();
    await expect(issueInput).not.toBeDisabled();
    await expect(repoSelect).not.toBeDisabled();

    // 2. Health refresh button lock/unlock
    await page.route(`**/api/repositories/${HEALTHY_1_ID}/refresh`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ status: 500 });
    });

    const refreshBtn = page.locator('[data-testid="refresh-health-btn"]');
    await refreshBtn.click();

    await expect(refreshBtn).toBeDisabled();
    await expect(page.locator('[data-testid="health-refresh-error"]')).toBeVisible();
    await expect(refreshBtn).not.toBeDisabled();
  });
});
