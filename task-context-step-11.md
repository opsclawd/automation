# Task Context: Task 11

Title: Multi-repo API Integration Tests
## Workspace & Scope Constraints

## WORKSPACE CONSTRAINTS

Your working directory is a dedicated git worktree with the repository's complete history. Run all commands from it. Do NOT cd to or read paths outside this directory — external-directory access is automatically rejected. git log, git diff, etc. work here directly.

.ai-orchestrator.local.json, if one exists, lives only in the main checkout and is intentionally not copied into your worktree — it is operator-machine-specific and not part of your task. Do not search for it or read it outside this directory. Reason about configuration using only .ai-orchestrator.json in your own working directory; treat it as the effective config for your task.

Working Directory: /home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-649
Repository: opsclawd/automation
Branch: ai/issue-649
Start Commit: 2e3fe2ca237148354b8700279baf362062c5fdfb

## Task Requirements

**Files:**
- Create: `apps/api/src/__tests__/multi-repo-api-routes.test.ts`

**Interfaces:**
- Consumes: HTTP server API endpoints
- Produces: E2E validations covering multiple repositories

- [ ] **Step 1: Write integration tests**

```typescript
// apps/api/src/__tests__/multi-repo-api-routes.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { buildTestServer } from './helpers/test-server';

describe('multi-repo API routes', () => {
  let server: Awaited<ReturnType<typeof buildTestServer>>;
  let repoA: { id: string; fullName: string };
  let repoB: { id: string; fullName: string };

  beforeEach(async () => {
    server = await buildTestServer();
    repoA = await server.registerRepository('owner/repo-a');
    repoB = await server.registerRepository('owner/repo-b');
  });

  it('GET /api/runs?repositoryId=<A> filters out repo B runs', async () => {
    await server.startIssue({ issueNumber: 42, repositoryId: repoA.id });
    await server.startIssue({ issueNumber: 42, repositoryId: repoB.id });
    const aRuns = await server.get('/api/runs', { query: { repositoryId: repoA.id } });
    expect(aRuns.json.runs.every((r: any) => r.repoId === repoA.id)).toBe(true);
  });

  it('GET /api/runs/:uuid from A returns 404 from B context', async () => {
    const runA = await server.startIssue({ issueNumber: 7, repositoryId: repoA.id });
    const wrongCtx = await server.get(`/api/runs/${runA.uuid}`, { headers: { 'x-repository-id': repoB.id } });
    expect(wrongCtx.status).toBe(404);
  });

  it('POST /api/runs/:uuid/cancel with wrong repo context returns 404', async () => {
    const runA = await server.startIssue({ issueNumber: 7, repositoryId: repoA.id });
    const wrongCancel = await server.post(`/api/runs/${runA.uuid}/cancel`, {}, { headers: { 'x-repository-id': repoB.id } });
    expect(wrongCancel.status).toBe(404);
  });

  it('POST /api/runs without repositoryId when two repos enabled returns 400', async () => {
    const res = await server.post('/api/runs', { issueNumber: 1 }, {});
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('missing_repository_id');
  });

  it('POST /api/runs with disabled repo returns 409 naming the repo', async () => {
    await server.disableRepository(repoA.id);
    const res = await server.post('/api/runs', { issueNumber: 1, repositoryId: repoA.id }, {});
    expect(res.status).toBe(409);
    expect(res.json.error).toMatch(/disabled|not_approved/);
    expect(JSON.stringify(res.json)).toContain(repoA.fullName);
  });

  it('GET /api/runs?repositoryId=owner/repo-a (legacy form) resolves to canonical id', async () => {
    await server.startIssue({ issueNumber: 11, repositoryId: repoA.id });
    const res = await server.get('/api/runs', { query: { repositoryId: 'owner/repo-a' } });
    expect(res.json.runs.length).toBeGreaterThan(0);
  });

  it('POST /api/runs with header X-Repository-Id: owner/name resolves and creates under correct repo', async () => {
    const res = await server.post(
      '/api/runs',
      { issueNumber: 12 },
      { headers: { 'x-repository-id': 'owner/repo-a' } },
    );
    expect(res.status).toBe(201);
    expect(res.json.run.repoId).toBe(repoA.id);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run apps/api/src/__tests__/multi-repo-api-routes.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/multi-repo-api-routes.test.ts
git commit -m "test(api): multi-repo API route integration coverage"
```

---

