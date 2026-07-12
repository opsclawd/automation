import { test, expect } from '@playwright/test';

const HEALTHY_1_ID = 'f18c6375af9525d8fd93f40691bdd554d74c6ad67630ecd87cdac6fb08d7b45b';
const HEALTHY_2_ID = '34feb66c2f259a456d6b5134d520cd73d4935462a91636811e8fa1c6de07d345';

test('Review/Fix tab renders converged and exhausted loop badges with iteration rows', async ({
  page,
}) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  await page.route(`**/api/runs/${runId}/review-fix*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_1_ID);
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
                qualityReviewInvocationId: null,
                lockInvocationId: null,
                fixInvocationId: 'fa1',
                revalidationId: 'rv1',
                reviewArtifactPath:
                  'review-fix/loop-a/review/whole-pr-review/iter-1/code-review.md',
                fixArtifactPath: 'review-fix/loop-a/fix/whole-pr-review/iter-1/result.json',
                revalidateArtifactPath:
                  'revalidate/loop-a/whole-pr-review/iter-1/validation-result.json',
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
                qualityReviewInvocationId: null,
                lockInvocationId: null,
                fixInvocationId: 'fb1',
                revalidationId: null,
                reviewArtifactPath: 'review-fix/loop-b/review/code-review/iter-1/code-review.md',
                fixArtifactPath: 'review-fix/loop-b/fix/code-review/iter-1/result.json',
                revalidateArtifactPath: null,
                startedAt: '2026-06-14T00:07:00.000Z',
                completedAt: '2026-06-14T00:09:00.000Z',
              },
              {
                index: 2,
                outcome: 'unresolved',
                reviewInvocationId: 'rb2',
                qualityReviewInvocationId: null,
                lockInvocationId: null,
                fixInvocationId: 'fb2',
                revalidationId: 'rv2',
                reviewArtifactPath: 'review-fix/loop-b/review/code-review/iter-2/code-review.md',
                fixArtifactPath: 'review-fix/loop-b/fix/code-review/iter-2/result.json',
                revalidateArtifactPath:
                  'revalidate/loop-b/code-review/iter-2/validation-result.json',
                startedAt: '2026-06-14T00:10:00.000Z',
                completedAt: '2026-06-14T00:12:00.000Z',
              },
            ],
          },
        ],
      }),
    });
  });

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

  await page.route(`**/api/runs/${emptyRunId}/review-fix*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_2_ID);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ loops: [] }),
    });
  });

  await page.route(`**/api/runs/${emptyRunId}*`, async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('repositoryId')).toBe(HEALTHY_2_ID);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        run: {
          uuid: emptyRunId,
          displayId: 'R-002',
          issueNumber: 1,
          status: 'running',
          currentPhase: null,
          completedPhases: ['implement'],
          startedAt: new Date().toISOString(),
          completedAt: null,
          durationMs: 10000,
          exitCode: null,
          failureReason: null,
          repoId: HEALTHY_2_ID,
        },
        failure: null,
      }),
    });
  });

  await page.goto(`/repositories/${HEALTHY_2_ID}/runs/${emptyRunId}`);
  await page.getByRole('tab', { name: 'Review/Fix' }).click();

  await expect(page.getByText('No review/fix activity for this run.')).toBeVisible();
});
