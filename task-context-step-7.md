# Task Context: Task 7

Title: Wire-up in compose.ts
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
- Modify: `apps/api/src/compose.ts`

**Interfaces:**
- Consumes: `LoadRepositoryForRun`, `RepositoryPort` from `SqliteRepositoryRegistry`
- Produces: Updated container with `loadRepositoryForRun` instance and updated `startIssueRun` dependencies.

- [ ] **Step 1: Add imports**

```typescript
import { LoadRepositoryForRun } from '@ai-sdlc/application/use-cases/load-repository-for-run';
```

- [ ] **Step 2: Construct and inject**

```typescript
const repositoryPort = sqliteRepositoryRegistry; // the existing SqliteRepositoryRegistry instance

const loadRepositoryForRun = new LoadRepositoryForRun({ repositoryPort });

const startIssueRun = new StartIssueRun({
  // ... existing deps ...
  repositoryPort,
});

const container = {
  // ... existing fields ...
  loadRepositoryForRun,
};
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm -r typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/compose.ts
git commit -m "feat(api): wire LoadRepositoryForRun and repositoryPort into container"
```

---

