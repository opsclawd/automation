import { test, expect } from '@playwright/test';

test('Review/Fix tab renders converged and exhausted loop badges with iteration rows', async ({
  page,
}) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  await page.route(`**/api/runs/${runId}/review-fix`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        loops: [
          {
            id: 'loop-a',
            phaseId: 'whole-pr-review',
            type: 'review-fix',
            status: 'converged',
            maxIterations: 3,
            startedAt: '2026-06-14T00:00:00.000Z',
            completedAt: '2026-06-14T00:05:00.000Z',
            iterations: [
              {
                index: 1,
                outcome: 'resolved',
                reviewInvocationId: 'ra1',
                fixInvocationId: 'fa1',
                revalidationId: 'rv1',
                reviewArtifactPath: 'review-fix/review/whole-pr-review/iter-1/code-review.md',
                fixArtifactPath: 'review-fix/fix/whole-pr-review/iter-1/result.json',
                revalidateArtifactPath: 'revalidate/whole-pr-review/iter-1/validation-result.json',
                startedAt: '2026-06-14T00:01:00.000Z',
                completedAt: '2026-06-14T00:03:00.000Z',
              },
            ],
          },
          {
            id: 'loop-b',
            phaseId: 'code-review',
            type: 'review-fix',
            status: 'exhausted',
            maxIterations: 2,
            startedAt: '2026-06-14T00:06:00.000Z',
            completedAt: '2026-06-14T00:12:00.000Z',
            iterations: [
              {
                index: 1,
                outcome: 'unresolved',
                reviewInvocationId: 'rb1',
                fixInvocationId: 'fb1',
                revalidationId: null,
                reviewArtifactPath: 'review-fix/review/code-review/iter-1/code-review.md',
                fixArtifactPath: 'review-fix/fix/code-review/iter-1/result.json',
                revalidateArtifactPath: null,
                startedAt: '2026-06-14T00:07:00.000Z',
                completedAt: '2026-06-14T00:09:00.000Z',
              },
              {
                index: 2,
                outcome: 'unresolved',
                reviewInvocationId: 'rb2',
                fixInvocationId: 'fb2',
                revalidationId: 'rv2',
                reviewArtifactPath: 'review-fix/review/code-review/iter-2/code-review.md',
                fixArtifactPath: 'review-fix/fix/code-review/iter-2/result.json',
                revalidateArtifactPath: 'revalidate/code-review/iter-2/validation-result.json',
                startedAt: '2026-06-14T00:10:00.000Z',
                completedAt: '2026-06-14T00:12:00.000Z',
              },
            ],
          },
        ],
      }),
    });
  });

  await page.goto(`/runs/${runId}`);
  await page.getByRole('tab', { name: 'Review/Fix' }).click();

  await expect(page.getByText('Converged')).toBeVisible();
  await expect(page.getByText('Exhausted')).toBeVisible();
  await expect(page.getByText('1 / 3 iterations')).toBeVisible();
  await expect(page.getByText('2 / 2 iterations')).toBeVisible();
  await expect(page.getByText('resolved', { exact: true })).toBeVisible();
  await expect(page.locator('text=unresolved')).toHaveCount(2);
});

test('Review/Fix tab shows empty state for a run with no loops', async ({ page }) => {
  const emptyRunId = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

  await page.route(`**/api/runs/${emptyRunId}/review-fix`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ loops: [] }),
    });
  });

  await page.goto(`/runs/${emptyRunId}`);
  await page.getByRole('tab', { name: 'Review/Fix' }).click();

  await expect(page.getByText('No review/fix activity for this run.')).toBeVisible();
});
