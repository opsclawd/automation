# Task Context: Task 6

Title: Extend StartIssueRun use case
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
- Modify: `packages/application/src/start-issue-run.ts`
- Modify: `packages/application/src/__tests__/start-issue-run.test.ts`

**Interfaces:**
- Consumes: `StartIssueRunDeps` (adding `repositoryPort` from Task 4 with `findById` and `listEnabled`)
- Produces: Extended `StartIssueRun` that resolves `repoId` using the rules, and reads/uses the repository's `localBasePath` **directly from the registry** — replacing the existing `this.deps.runsDir.replace(/\/\.ai-runs$/, '')` filesystem heuristic with `repositoryPort.findById(repoId).localBasePath`.

- [ ] **Step 1: Write the failing test**

Append to `packages/application/src/__tests__/start-issue-run.test.ts`:

```typescript
describe('StartIssueRun repository resolution', () => {
  it('uses the explicit repoId when supplied', async () => {
    const repoA = { id: 'a'.repeat(64), fullName: 'owner/repo-a', enabled: true, healthStatus: 'healthy', localBasePath: '/repos/a' } as any;
    const deps = baseDeps({ repositoryPort: { findById: (id: string) => id === repoA.id ? repoA : undefined, listEnabled: () => [repoA] } });
    const result = await startIssueRun.execute({ issueNumber: 42, repoId: repoA.id } as any);
    expect(result.repoId).toBe(repoA.id);
  });

  it('defaults to the single enabled repository when omitted', async () => {
    const repoA = { id: 'a'.repeat(64), fullName: 'owner/repo-a', enabled: true, healthStatus: 'healthy', localBasePath: '/repos/a' } as any;
    const deps = baseDeps({ repositoryPort: { findById: () => repoA, listEnabled: () => [repoA] } });
    const result = await startIssueRun.execute({ issueNumber: 42 } as any);
    expect(result.repoId).toBe(repoA.id);
  });

  it('throws RepositoryValidationError when many enabled repos and no explicit id', async () => {
    const repoA = { id: 'a'.repeat(64), fullName: 'owner/repo-a', enabled: true, healthStatus: 'healthy', localBasePath: '/repos/a' } as any;
    const repoB = { id: 'b'.repeat(64), fullName: 'owner/repo-b', enabled: true, healthStatus: 'healthy', localBasePath: '/repos/b' } as any;
    const deps = baseDeps({ repositoryPort: { findById: () => undefined, listEnabled: () => [repoA, repoB] } });
    await expect(startIssueRun.execute({ issueNumber: 42 } as any)).rejects.toThrow(/repoId|repositoryId/);
  });

  it('throws RepositoryNotApprovedError naming the repo when target repo is degraded or unreachable', async () => {
    const repoA = { id: 'a'.repeat(64), fullName: 'owner/repo-a', enabled: true, healthStatus: 'unreachable', localBasePath: '/repos/a' } as any;
    const deps = baseDeps({ repositoryPort: { findById: () => repoA, listEnabled: () => [repoA] } });
    await expect(startIssueRun.execute({ issueNumber: 42, repoId: repoA.id } as any))
      .rejects.toThrow(/owner\/repo-a.*unreachable|degraded|not approved/);
  });

  it('uses repo.localBasePath for the worktreeRoot (not the runsDir filesystem heuristic)', async () => {
    const repoA = { id: 'a'.repeat(64), fullName: 'owner/repo-a', enabled: true, healthStatus: 'healthy', localBasePath: '/srv/repos/repo-a-root' } as any;
    const deps = baseDeps({
      runsDir: '/srv/repos/repo-a-root/.ai-runs',
      repositoryPort: { findById: () => repoA, listEnabled: () => [repoA] },
      resolveRefSha: (worktreeRoot: string) => {
        (deps as any)._capturedWorktreeRoot = worktreeRoot;
        return 'sha-from-test';
      },
    });
    await startIssueRun.execute({ issueNumber: 7, repoId: repoA.id } as any);
    expect((deps as any)._capturedWorktreeRoot).toBe(`/srv/repos/repo-a-root/.ai-worktrees/issue-7`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/application/src/__tests__/start-issue-run.test.ts`
Expected: FAIL — `repositoryPort` not in `StartIssueRunDeps`, and the worktree-root currently derives from `runsDir` not from `repo.localBasePath`.

- [ ] **Step 3: Add the dependency to `StartIssueRunDeps`**

In `packages/application/src/start-issue-run.ts`:

```typescript
import type { Repository } from '@ai-sdlc/domain/repository';
import { RepositoryNotApprovedError, RepositoryValidationError } from '@ai-sdlc/domain/repository';

export interface StartIssueRunDeps {
  // ... existing deps ...
  repositoryPort: {
    findById(id: RepositoryId): Repository | undefined;
    listEnabled(): Repository[];
  };
}
```

- [ ] **Step 4: Add resolution logic at the top of `execute` and use `repo.localBasePath` instead of the runsDir heuristic**

```typescript
async execute(input: StartIssueRunInput): Promise<StartIssueRunOutput> {
  const { repositoryPort } = this.deps;

  // Resolve repoId:
  let repoId: RepositoryId;
  if (input.repoId) {
    repoId = input.repoId;
  } else {
    const enabled = repositoryPort.listEnabled();
    if (enabled.length === 1) {
      repoId = enabled[0].id;
    } else {
      throw new RepositoryValidationError(
        `repoId is required when more than one repository is enabled (found ${enabled.length})`,
        'StartIssueRun.input.repoId',
      );
    }
  }

  // Approve repository by registry state.
  const repo = repositoryPort.findById(repoId);
  if (!repo) {
    throw new RepositoryNotApprovedError(repoId);
  }
  if (!repo.enabled) {
    throw new RepositoryNotApprovedError(repoId, `Repository '${repo.fullName}' is disabled`);
  }
  if (repo.healthStatus === 'degraded' || repo.healthStatus === 'unreachable') {
    throw new RepositoryNotApprovedError(repoId, `Repository '${repo.fullName}' is degraded or unreachable`);
  }

  // Use the registry-defined localBasePath.
  const repoRoot = repo.localBasePath;

  const now = this.deps.now ?? (() => new Date());
  const logger = this.deps.logger ?? { error: (m, e) => console.error(m, e) };
  const startedAt = now();
  const ids = newRunId({ issueNumber: input.issueNumber, now: startedAt });
  const run = createRun({
    uuid: ids.uuid,
    displayId: ids.displayId,
    issueNumber: input.issueNumber,
    startedAt,
    repoId,
  });
  this.deps.runRepository.insertIfNoActive(run);
  // ... existing runRepository.insert + dir creation, using `repoRoot` for the worktreeRoot ...
  if (this.deps.resolveRefSha) {
    try {
      const worktreeRoot = `${repoRoot}/.ai-worktrees/issue-${run.issueNumber}`;
      const sha = this.deps.resolveRefSha(
        worktreeRoot,
        `origin/${this.deps.baseBranch ?? 'main'}`,
      );
      if (sha) {
        this.deps.runRepository.update(run.uuid, { startCommitSha: sha });
      }
    } catch (e) {
      logger.error(`Failed to capture startCommitSha from worktree for ${run.displayId}`, e);
    }
  }
  // ... existing pipeline continues unchanged ...
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/application/src/__tests__/start-issue-run.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/application/src/start-issue-run.ts packages/application/src/__tests__/start-issue-run.test.ts
git commit -m "feat(application): StartIssueRun resolves repositoryId and uses registry localBasePath"
```

---

