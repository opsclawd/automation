# Task Context: Task 8

Title: Update API Route Helpers and GET /api/runs
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
- Modify: `apps/api/src/routes/_lib.ts`
- Modify: `apps/api/src/routes/runs.ts`

**Interfaces:**
- Produces: `resolveRepoContext(req, container, options)` helper. Updated `GET /api/runs` supporting `repositoryId` and `status` query params, resolving `fullName` to canonical `repositoryId` when `?repositoryId=owner/name` is used.

- [ ] **Step 1: Add the helper**

In `apps/api/src/routes/_lib.ts`:

```typescript
import type { RepositoryId } from '@ai-sdlc/domain/ids';
import { RepositoryNotFoundError } from '@ai-sdlc/domain/repository';

export type ResolvedRepoContext = {
  repositoryId?: RepositoryId;
  fullName?: string;
};

export function resolveRepoContext(
  req: { headers: Record<string, string | string[] | undefined>; query: Record<string, unknown> },
  container: { repoFullName?: string },
  options?: { allowFallback?: boolean }
): ResolvedRepoContext {
  const headerVal = req.headers['x-repository-id'];
  const header = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  const queryVal = (req.query.repositoryId ?? req.query.repo) as string | undefined;
  const raw = (header || queryVal || '').trim();
  if (!raw) {
    if (options?.allowFallback === false) {
      return {};
    }
    return { fullName: container.repoFullName };
  }
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    return { repositoryId: raw.toLowerCase() as RepositoryId };
  }
  return { fullName: raw };
}

/**
 * Resolve a ResolvedRepoContext to a canonical RepositoryId by looking up
 * `fullName` via the registry. Returns the canonical id on success, throws
 * `RepositoryNotFoundError` if neither `repositoryId` nor `fullName` resolves.
 */
export function canonicalizeRepoContext(
  ctx: ResolvedRepoContext,
  container: { inspectRepository: { executeByFullName(fullName: string): { id: RepositoryId } } },
): RepositoryId {
  if (ctx.repositoryId) return ctx.repositoryId;
  if (ctx.fullName) {
    try {
      return container.inspectRepository.executeByFullName(ctx.fullName).id;
    } catch (err) {
      if (err instanceof RepositoryNotFoundError) throw err;
      throw err;
    }
  }
  throw new RepositoryNotFoundError('<none>');
}
```

- [ ] **Step 2: Update `GET /api/runs` to resolve `fullName`**

In `apps/api/src/routes/runs.ts`:

```typescript
import { resolveRepoContext, canonicalizeRepoContext } from './_lib';
import { RepositoryNotFoundError } from '@ai-sdlc/domain/repository';

router.get('/api/runs', async (req, res, next) => {
  try {
    const ctx = resolveRepoContext(req, container);
    let repositoryId: RepositoryId | undefined;
    if (ctx.repositoryId || ctx.fullName) {
      try {
        repositoryId = canonicalizeRepoContext(ctx, container);
      } catch (err) {
        if (err instanceof RepositoryNotFoundError) {
          return res.status(404).json({ error: 'repository_not_found' });
        }
        throw err;
      }
    }
    const status = typeof req.query.status === 'string' ? (req.query.status as RunStatus) : undefined;
    const limit = clampLimit(req.query.limit);
    const offset = clampOffset(req.query.offset);
    const result = await container.runRepository.list({ limit, offset, repositoryId, status });
    res.json({ runs: result.runs, total: result.total });
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm -r typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/_lib.ts apps/api/src/routes/runs.ts
git commit -m "feat(api): resolveRepoContext helper and GET /api/runs filters"
```

---

