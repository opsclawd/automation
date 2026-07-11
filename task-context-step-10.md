# Task Context: Task 10

Title: Update remaining run-scoped read routes
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
- Modify: `apps/api/src/routes/runs.ts` and any of `artifacts.ts`, `events.ts`, `invocations.ts`, `pr-review.ts`, `review-fix.ts`, `validation.ts` that scope to a run.

**Interfaces:**
- Produces: Read-side run endpoints updated with `LoadRepositoryForRun` using `strictMatch: false`. Errors mapped per Design 3.5:
  - `RunRepositoryMismatchError` → `404 not_found`
  - `RunRepositoryMissingError` → `409 repository_missing`
  - `RepositoryNotApprovedError` → `409 denied`

- [ ] **Step 1: Implement `guardRead` and apply to each run-scoped GET**

```typescript
async function guardRead(req, res, container) {
  const uuid = req.params.uuid;
  const run = await container.runRepository.findByUuid(uuid);
  if (!run) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  const ctx = resolveRepoContext(req, container);
  let resolvedRepoId: RepositoryId | undefined;
  try {
    resolvedRepoId = canonicalizeRepoContext(ctx, container);
  } catch (err) {
    if (err instanceof RepositoryNotFoundError) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    throw err;
  }
  try {
    container.loadRepositoryForRun.execute({
      run,
      callerRepoId: resolvedRepoId,
      strictMatch: false,
    });
  } catch (err) {
    if (err instanceof RunRepositoryMismatchError) {
      res.status(404).json({ error: 'not_found' });
      return null;
    }
    if (err instanceof RunRepositoryMissingError) {
      res.status(409).json({ error: 'repository_missing' });
      return null;
    }
    throw err;
  }
  return run;
}
```

- [ ] **Step 2: Apply `guardRead` to each run-scoped GET handler**

For each of:
- `GET /api/runs/:uuid`
- `GET /api/runs/:uuid/artifacts`
- `GET /api/runs/:uuid/invocations`
- `GET /api/runs/:uuid/events`
- `GET /api/runs/:uuid/validation`
- `GET /api/runs/:uuid/pr-review`
- `GET /api/runs/:uuid/review-fix`

Insert the same prelude:

```typescript
const run = await guardRead(req, res, container);
if (!run) return;
// existing handler body that reads from `run`
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm -r typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/
git commit -m "feat(api): read-side run routes guarded by LoadRepositoryForRun"
```

---

