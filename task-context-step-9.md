# Task Context: Task 9

Title: Implement POST /api/runs and mutate routes
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
- Modify: `apps/api/src/routes/runs.ts`

**Interfaces:**
- Produces: `POST /api/runs` endpoint for run creation with canonical ID resolution. Updated `POST /api/runs/:uuid/cancel`, `resume`, `retry` with `loadRepositoryForRun` using `strictMatch: true`.

- [ ] **Step 1: Implement `POST /api/runs` with fullName-to-ID lookup**

```typescript
import { RepositoryNotApprovedError, RepositoryValidationError } from '@ai-sdlc/domain/repository';

function mapRunCreateError(err: unknown) {
  if (err instanceof RepositoryNotApprovedError) {
    return { status: 409, body: { error: 'repository_not_approved', message: err.message } };
  }
  if (err instanceof RepositoryValidationError) {
    return { status: 400, body: { error: 'missing_repository_id', message: err.message } };
  }
  return err;
}

router.post('/api/runs', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const issueNumber = Number(body.issueNumber);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return res.status(400).json({ error: 'invalid_issue_number' });
    }
    const ctx = resolveRepoContext(req, container);
    let repositoryId = ctx.repositoryId ?? body.repositoryId;
    const fullName = ctx.fullName ?? body.repo;
    if (!repositoryId && fullName) {
      try {
        const repo = container.inspectRepository.executeByFullName(fullName);
        repositoryId = repo.id;
      } catch (err) {
        if (err instanceof RepositoryNotFoundError) {
          return res.status(404).json({ error: 'repository_not_found' });
        }
        throw err;
      }
    }
    const run = await container.startIssueRun.execute({
      issueNumber,
      repoId: repositoryId,
      baseBranch: typeof body.baseBranch === 'string' ? body.baseBranch : undefined,
    } as any);
    res.status(201).json({ run });
  } catch (err) {
    const mapped = mapRunCreateError(err);
    if ('status' in mapped) {
      return res.status(mapped.status).json(mapped.body);
    }
    next(err);
  }
});
```

- [ ] **Step 2: Apply `LoadRepositoryForRun` to mutation endpoints**

```typescript
async function guardMutation(req, res, container, action: 'cancel' | 'resume' | 'retry') {
  const uuid = req.params.uuid;
  const run = await container.runRepository.findByUuid(uuid);
  if (!run) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  const ctx = resolveRepoContext(req, container, { allowFallback: false });
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
      strictMatch: true,
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

router.post('/api/runs/:uuid/cancel', async (req, res, next) => {
  try {
    const run = await guardMutation(req, res, container, 'cancel');
    if (!run) return;
    const result = await container.cancelRun.execute({ runUuid: run.uuid });
    res.json({ result });
  } catch (err) { next(err); }
});
// Same shape for /resume and /retry.
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm -r typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/runs.ts
git commit -m "feat(api): POST /api/runs and LoadRepositoryForRun guards on mutations"
```

---

