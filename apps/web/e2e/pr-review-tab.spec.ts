import { test, expect } from '@playwright/test';

test('PR Review tab shows comment cards and poll status panel', async ({ page }) => {
  const runId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  // Mock the PR Review API response so the client-side PrReviewPanel fetch
  // returns deterministic data without modifying the DB seed.
  await page.route(`**/api/runs/${runId}/pr-review`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        comments: [
          {
            commentId: 9001,
            prNumber: 5,
            path: 'src/a.ts',
            line: 3,
            reviewer: 'octocat',
            body: 'please fix this',
            state: 'replied',
            attempts: 1,
            outcome: 'fixed',
            replyId: 1,
            commitSha: 'abc123',
            commitVerified: true,
            replyVerified: true,
            buildVerified: false,
            blockedReason: null,
            lastPoll: 1,
            replyBody: 'done, thanks',
          },
          {
            commentId: 9002,
            prNumber: 5,
            path: 'src/b.ts',
            line: 10,
            reviewer: 'devbot',
            body: 'consider refactoring',
            state: 'blocked',
            attempts: 2,
            outcome: null,
            replyId: null,
            commitSha: null,
            commitVerified: false,
            replyVerified: false,
            buildVerified: false,
            blockedReason: 'unresolved dependency',
            lastPoll: 1,
            replyBody: null,
          },
        ],
        pollAttempts: [
          {
            id: 'p1',
            pollNumber: 1,
            status: 'completed',
            commentsFetched: 2,
            commentsProcessed: 1,
            startedAt: '2026-06-04T00:00:00.000Z',
            completedAt: '2026-06-04T00:05:00.000Z',
            nextPollAt: '2026-06-04T00:10:00.000Z',
            terminalState: 'blocked',
          },
        ],
      }),
    });
  });

  await page.goto(`/runs/${runId}`);
  await page.getByRole('tab', { name: 'PR Review' }).click();

  // Poll status panel
  await expect(page.getByText('Polls run:')).toBeVisible();
  await expect(page.getByText('Terminal:')).toBeVisible();
  await expect(page.getByText('blocked')).toBeVisible();

  // Comment cards — unresolved-first means 'blocked' (9002) appears before 'replied' (9001)
  const cards = page.locator('li', { has: page.locator('code') });
  await expect(cards.nth(0)).toContainText('src/b.ts:10');
  await expect(cards.nth(0)).toContainText('blocked');
  await expect(cards.nth(0)).toContainText('unresolved dependency');
  await expect(cards.nth(1)).toContainText('src/a.ts:3');
  await expect(cards.nth(1)).toContainText('replied');
  await expect(cards.nth(1)).toContainText('done, thanks');

  // Verification flags on the replied comment (second card)
  // commit verified = ✓ (green), build verified = ○ (not verified)
  await expect(cards.nth(1)).toContainText('\u2713 commit');
  await expect(cards.nth(1)).toContainText('\u25CB build');
});
