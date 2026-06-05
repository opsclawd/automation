# M6-06 — UI PR Review Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "PR Review" tab to the run-detail page showing per-comment cards (file, line, reviewer, body, state, agent action, reply body, verification flags) and a poll-status panel (poll count, max, latest status, next poll, terminal state).

**Architecture:** A read-only API route `GET /api/runs/:uuid/pr-review` serialises `PrReviewComment[]` + `PollAttempt[]` from `PrReviewRepository` (M6-01). The web app gains a `listPrReview` API client function, a `PrReviewPanel` client component, and a new tab in `RunDetailTabs`. Mirrors the existing validation slice exactly: `apps/api/src/routes/validation.ts` → `apps/web/src/lib/api-client.ts` (`listValidation`) → `apps/web/src/components/ValidationPanel.tsx` → `RunDetailTabs`.

**Tech Stack:** Fastify (API), Next.js 15 App Router + React + Tailwind (web), Vitest, Playwright.

**Depends on:** M6-01 (repo + types), M6-03/M6-04 (data producers — the tab renders whatever is persisted).

---

### Task 1: API route `GET /api/runs/:uuid/pr-review`

**Files:**
- Create: `apps/api/src/routes/pr-review.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/__tests__/pr-review-api.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/api/src/__tests__/pr-review-api.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { RunId, createPrReviewComment, markReplied } from '@ai-sdlc/domain';
import { registerPrReviewRoutes } from '../routes/pr-review.js';
import { FakePrReviewRepository } from '@ai-sdlc/application/test-doubles';

const runUuid = '66666666-6666-6666-6666-666666666666';

function buildApp(repo: FakePrReviewRepository) {
  const app = Fastify();
  registerPrReviewRoutes(app, { prReviewRepository: repo } as never);
  return app;
}

describe('GET /api/runs/:uuid/pr-review', () => {
  let repo: FakePrReviewRepository;
  beforeEach(() => {
    repo = new FakePrReviewRepository();
  });

  it('400 on bad uuid', async () => {
    const app = buildApp(repo);
    const res = await app.inject({ method: 'GET', url: '/api/runs/not-a-uuid/pr-review' });
    expect(res.statusCode).toBe(400);
  });

  it('returns comments and poll attempts', async () => {
    const runId = RunId(runUuid);
    const c = createPrReviewComment({ runId, prNumber: 5, commentId: 9001, path: 'a.ts', line: 3, reviewer: 'octocat', body: 'fix', now: new Date('2026-06-04T00:00:00Z') });
    repo.upsertComment(markReplied(c, { replyId: 1, outcome: 'fixed', commitSha: 'abc', poll: 1 }));
    repo.insertPollAttempt({ id: 'p1', runId, prNumber: 5, pollNumber: 1, status: 'completed', commentsFetched: 1, commentsProcessed: 1, startedAt: new Date('2026-06-04T00:00:00Z'), completedAt: new Date('2026-06-04T00:05:00Z'), terminalState: 'all_resolved' });

    const app = buildApp(repo);
    const res = await app.inject({ method: 'GET', url: `/api/runs/${runUuid}/pr-review` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.comments[0]).toMatchObject({ commentId: 9001, state: 'replied', reviewer: 'octocat', outcome: 'fixed' });
    expect(body.pollAttempts[0]).toMatchObject({ pollNumber: 1, status: 'completed', terminalState: 'all_resolved' });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/api test -- pr-review-api`
Expected: FAIL — route module not found.

- [ ] **Step 3: Implement the route** (mirror `routes/validation.ts`)

```typescript
// apps/api/src/routes/pr-review.ts
import type { FastifyInstance } from 'fastify';
import { RunId } from '@ai-sdlc/domain';
import type { Container } from '../compose.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerPrReviewRoutes(app: FastifyInstance, c: Container): void {
  app.get<{ Params: { uuid: string } }>('/api/runs/:uuid/pr-review', async (req, reply) => {
    const { uuid } = req.params;
    if (!UUID_RE.test(uuid)) {
      reply.code(400);
      return { error: 'invalid run uuid' };
    }
    const runId = RunId(uuid);
    const comments = c.prReviewRepository.listComments(runId).map((cm) => ({
      commentId: cm.commentId,
      prNumber: cm.prNumber,
      path: cm.path,
      line: cm.line,
      reviewer: cm.reviewer,
      body: cm.body,
      state: cm.state,
      attempts: cm.attempts,
      outcome: cm.outcome ?? null,
      replyId: cm.replyId ?? null,
      commitSha: cm.commitSha ?? null,
      commitVerified: cm.commitVerified,
      replyVerified: cm.replyVerified,
      buildVerified: cm.buildVerified,
      blockedReason: cm.blockedReason ?? null,
      lastPoll: cm.lastPoll,
    }));
    const replies = c.prReviewRepository.listReplies(runId);
    const pollAttempts = c.prReviewRepository.listPollAttempts(runId).map((p) => ({
      id: p.id,
      pollNumber: p.pollNumber,
      status: p.status,
      commentsFetched: p.commentsFetched,
      commentsProcessed: p.commentsProcessed,
      startedAt: p.startedAt.toISOString(),
      completedAt: p.completedAt?.toISOString() ?? null,
      nextPollAt: p.nextPollAt?.toISOString() ?? null,
      terminalState: p.terminalState ?? null,
    }));
    // Attach reply bodies to comments for the UI.
    const commentsWithReply = comments.map((cm) => ({
      ...cm,
      replyBody: replies.find((r) => r.commentId === cm.commentId)?.body ?? null,
    }));
    return { comments: commentsWithReply, pollAttempts };
  });
}
```

- [ ] **Step 4: Register the route in `server.ts`**

Add the import + registration next to the validation route:

```typescript
import { registerPrReviewRoutes } from './routes/pr-review.js';
// ...
registerPrReviewRoutes(app, container);
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/api test -- pr-review-api && pnpm --filter @ai-sdlc/api typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/pr-review.ts apps/api/src/server.ts apps/api/src/__tests__/pr-review-api.test.ts
git commit -m "feat(api): GET /api/runs/:uuid/pr-review (M6-06)"
```

---

### Task 2: Web API client + DTO types

**Files:**
- Modify: `apps/web/src/lib/api-client.ts`
- Create: `apps/web/src/lib/pr-review.ts`
- Test: `apps/web/src/lib/__tests__/pr-review.test.ts`

- [ ] **Step 1: Write the failing test for a pure sort/group helper**

```typescript
// apps/web/src/lib/__tests__/pr-review.test.ts
import { describe, it, expect } from 'vitest';
import { sortCommentsUnresolvedFirst, type PrReviewCommentDto } from '../pr-review.js';

const c = (over: Partial<PrReviewCommentDto>): PrReviewCommentDto => ({
  commentId: 1, prNumber: 5, path: 'a.ts', line: 1, reviewer: 'r', body: 'b',
  state: 'pending', attempts: 0, outcome: null, replyId: null, commitSha: null,
  commitVerified: false, replyVerified: false, buildVerified: false,
  blockedReason: null, lastPoll: 0, replyBody: null, ...over,
});

describe('sortCommentsUnresolvedFirst', () => {
  it('puts pending/blocked before processed', () => {
    const sorted = sortCommentsUnresolvedFirst([
      c({ commentId: 1, state: 'processed' }),
      c({ commentId: 2, state: 'pending' }),
      c({ commentId: 3, state: 'blocked' }),
    ]);
    expect(sorted.map((x) => x.commentId)).toEqual([2, 3, 1]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/web test -- pr-review`
Expected: FAIL.

- [ ] **Step 3: Create the DTO + helper module**

```typescript
// apps/web/src/lib/pr-review.ts
export interface PrReviewCommentDto {
  commentId: number;
  prNumber: number;
  path: string;
  line: number;
  reviewer: string;
  body: string;
  state: 'pending' | 'replied' | 'processed' | 'blocked';
  attempts: number;
  outcome: 'fixed' | 'no_fix' | null;
  replyId: number | null;
  commitSha: string | null;
  commitVerified: boolean;
  replyVerified: boolean;
  buildVerified: boolean;
  blockedReason: string | null;
  lastPoll: number;
  replyBody: string | null;
}

export interface PollAttemptDto {
  id: string;
  pollNumber: number;
  status: 'running' | 'completed' | 'failed' | 'rate_limited';
  commentsFetched: number;
  commentsProcessed: number;
  startedAt: string;
  completedAt: string | null;
  nextPollAt: string | null;
  terminalState: 'all_resolved' | 'max_polls_reached' | 'blocked' | null;
}

const ORDER: Record<PrReviewCommentDto['state'], number> = {
  pending: 0,
  blocked: 1,
  replied: 2,
  processed: 3,
};

export function sortCommentsUnresolvedFirst(comments: PrReviewCommentDto[]): PrReviewCommentDto[] {
  return [...comments].sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.commentId - b.commentId);
}
```

- [ ] **Step 4: Add the API client function**

In `apps/web/src/lib/api-client.ts`, add an import and a fetch function mirroring `listValidation`:

```typescript
import type { PrReviewCommentDto, PollAttemptDto } from './pr-review';

export interface PrReviewData {
  comments: PrReviewCommentDto[];
  pollAttempts: PollAttemptDto[];
}

export async function listPrReview(runUuid: string): Promise<PrReviewData> {
  const base = typeof window === 'undefined' ? apiUrl : '';
  const r = await fetch(`${base}/api/runs/${runUuid}/pr-review`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`failed to load pr-review: ${r.status}`);
  return (await r.json()) as PrReviewData;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/web test -- pr-review && pnpm --filter @ai-sdlc/web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/pr-review.ts apps/web/src/lib/api-client.ts apps/web/src/lib/__tests__/pr-review.test.ts
git commit -m "feat(web): pr-review API client + DTOs (M6-06)"
```

---

### Task 3: `PrReviewPanel` component

**Files:**
- Create: `apps/web/src/components/PrReviewPanel.tsx`
- Test: `apps/web/src/components/__tests__/PrReviewPanel.test.tsx` (if the web package has a component test setup; otherwise rely on Playwright in Task 5)

- [ ] **Step 1: Implement the component** (mirror `ValidationPanel.tsx` structure)

```tsx
// apps/web/src/components/PrReviewPanel.tsx
'use client';

import { useEffect, useState } from 'react';
import { listPrReview, type PrReviewData } from '@/lib/api-client';
import { sortCommentsUnresolvedFirst } from '@/lib/pr-review';

const STATE_PILL: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800',
  replied: 'bg-blue-100 text-blue-800',
  processed: 'bg-green-100 text-green-800',
  blocked: 'bg-red-100 text-red-800',
};

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`text-xs ${ok ? 'text-green-700' : 'text-slate-400'}`}>
      {ok ? '✓' : '○'} {label}
    </span>
  );
}

export function PrReviewPanel({ runUuid }: { runUuid: string }) {
  const [data, setData] = useState<PrReviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listPrReview(runUuid)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [runUuid]);

  if (error) return <div className="text-sm text-red-600">Failed to load PR review: {error}</div>;
  if (data === null) return <div className="text-sm text-slate-500">Loading PR review…</div>;
  if (data.comments.length === 0 && data.pollAttempts.length === 0)
    return <div className="text-sm text-slate-500">No PR review activity for this run.</div>;

  const latest = data.pollAttempts[data.pollAttempts.length - 1];
  const comments = sortCommentsUnresolvedFirst(data.comments);

  return (
    <div className="space-y-4">
      {/* Poll status panel */}
      <div className="rounded border bg-slate-50 p-3 text-sm">
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <span><b>Polls run:</b> {data.pollAttempts.length}</span>
          {latest && <span><b>Latest:</b> {latest.status}</span>}
          {latest?.terminalState && <span><b>Terminal:</b> {latest.terminalState}</span>}
          {latest?.nextPollAt && <span><b>Next poll:</b> {new Date(latest.nextPollAt).toLocaleString()}</span>}
        </div>
      </div>

      {/* Comment cards */}
      <ul className="space-y-2">
        {comments.map((cm) => (
          <li key={cm.commentId} className="rounded border p-3 text-sm space-y-1">
            <div className="flex items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATE_PILL[cm.state] ?? ''}`}>
                {cm.state}
              </span>
              <code className="font-mono text-xs">{cm.path}:{cm.line}</code>
              <span className="text-slate-500">@{cm.reviewer}</span>
              <span className="ml-auto text-xs text-slate-400">#{cm.commentId}</span>
            </div>
            <p className="text-slate-700 whitespace-pre-wrap">{cm.body}</p>
            {cm.outcome && <div className="text-xs text-slate-600"><b>Agent action:</b> {cm.outcome}</div>}
            {cm.replyBody && (
              <div className="rounded bg-slate-50 p-2 text-xs text-slate-700">
                <b>Reply:</b> {cm.replyBody}
              </div>
            )}
            {cm.blockedReason && <div className="text-xs text-red-700"><b>Blocked:</b> {cm.blockedReason}</div>}
            <div className="flex gap-3 pt-1">
              <Check ok={cm.commitVerified} label="commit" />
              <Check ok={cm.replyVerified} label="reply" />
              <Check ok={cm.buildVerified} label="build" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @ai-sdlc/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/PrReviewPanel.tsx
git commit -m "feat(web): PrReviewPanel component (M6-06)"
```

---

### Task 4: Add the tab to `RunDetailTabs`

**Files:**
- Modify: `apps/web/src/components/RunDetailTabs.tsx`

- [ ] **Step 1: Add the tab item and render branch**

```tsx
// import
import { PrReviewPanel } from './PrReviewPanel';

// add to TAB_ITEMS (after 'validation'):
  { id: 'pr-review', label: 'PR Review' },

// add render branch (after the validation branch):
  {activeTab === 'pr-review' && <PrReviewPanel runUuid={run.uuid} />}
```

- [ ] **Step 2: Typecheck + build the web app**

Run: `pnpm --filter @ai-sdlc/web typecheck && pnpm --filter @ai-sdlc/web build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/RunDetailTabs.tsx
git commit -m "feat(web): add PR Review tab to run detail (M6-06)"
```

---

### Task 5: Playwright smoke

**Files:**
- Create/extend: `apps/web/e2e/pr-review-tab.spec.ts`

- [ ] **Step 1: Write a smoke test** that seeds a run with PR-review data (via the API/DB seed helper the existing e2e suite uses), opens the run detail page, clicks the "PR Review" tab, and asserts a comment card + the poll status panel render.

```typescript
// apps/web/e2e/pr-review-tab.spec.ts
import { test, expect } from '@playwright/test';

test('PR Review tab shows comment cards and poll status', async ({ page }) => {
  // Reuse the e2e seeding helper used by run-detail-timeline.spec.ts to create
  // a run with pr_review_comments + poll_attempts rows. Then:
  await page.goto(`/runs/${process.env.E2E_RUN_UUID}`);
  await page.getByRole('tab', { name: 'PR Review' }).click();
  await expect(page.getByText('Polls run:')).toBeVisible();
  await expect(page.getByText('@octocat')).toBeVisible();
});
```

> **Implementer note:** Follow the existing seeding pattern in `apps/web/e2e/run-detail-timeline.spec.ts`. If that suite seeds via a fixture script, extend it to insert one `pr_review_comments` and one `poll_attempts` row.

- [ ] **Step 2: Run the e2e suite**

Run: `pnpm --filter @ai-sdlc/web e2e -- pr-review-tab` (or the repo's Playwright command)
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/pr-review-tab.spec.ts
git commit -m "test(web): Playwright smoke for PR Review tab (M6-06)"
```

---

### Task 6: Final verification

- [ ] **Step 1: Whole workspace green**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test`
Expected: all green.

---

## Self-review notes

- **Story coverage:** Per-comment cards show file/line, reviewer, body, processed state, agent action (`outcome`), reply body, and verification flags (commit/reply/build). Poll status panel shows poll count, latest status, terminal state, and next poll — matching the story's required fields.
- **Pattern fidelity:** The slice is a 1:1 mirror of the validation tab (route → api-client → panel → tab), so it inherits the repo's established conventions and review expectations.
- **Read-only:** No mutations from the UI; the tab reflects what M6-03/M6-04 persist. Agent-native parity is preserved because all actions remain agent/CLI-driven.
- **Live updates:** This uses a one-shot fetch on mount (like `ValidationPanel`). Live event-driven refresh can ride on the existing SSE timeline later; not required by this story.
