# Task Context: Task 4

Title: Wire buildOrphanedRunsSweeper into composeRoot and add startup sweep
## Workspace & Scope Constraints

## WORKSPACE CONSTRAINTS

Your working directory is a dedicated git worktree with the repository's complete history. Run all commands from it. Do NOT cd to or read paths outside this directory — external-directory access is automatically rejected. git log, git diff, etc. work here directly.

.ai-orchestrator.local.json, if one exists, lives only in the main checkout and is intentionally not copied into your worktree — it is operator-machine-specific and not part of your task. Do not search for it or read it outside this directory. Reason about configuration using only .ai-orchestrator.json in your own working directory; treat it as the effective config for your task.

Working Directory: /home/gary/.openclaw/workspace/automation/.ai-worktrees/issue-693
Repository: opsclawd/automation
Branch: ai/issue-693
Start Commit: eb7e4968fceba83f6c4f30687a035a1a859232f0

## Task Requirements

**Files:**

- Modify: `apps/api/src/compose.ts:57` (import)
- Modify: `apps/api/src/compose.ts:466` (Container interface)
- Modify: `apps/api/src/compose.ts:1300-1367` (startup sweep block)
- Modify: `apps/api/src/compose.ts:4033-4073` (factory region)
- Modify: `apps/api/src/compose.ts:4613` (return object)
- Test: `apps/api/src/__tests__/compose-sweep-waiting.test.ts`

- [ ] **Step 4.1: Write failing wiring test**

Add the following `describe` block to the bottom of `apps/api/src/__tests__/compose-sweep-waiting.test.ts`:

```ts
describe('composeRoot — OrphanedRunsSweeper wiring', () => {
  it('exposes buildOrphanedRunsSweeper that constructs a working OrphanedRunsSweeper', async () => {
    const { composeRoot } = await import('../compose.js');
    const repoRoot = makeRepo({ withPostPrReview: true });
    const c = composeRoot({ repoRoot, scriptPath: '/dev/null', runStartupSweeps: false });
    expect(c.buildOrphanedRunsSweeper).toBeTypeOf('function');
    const sweeper = c.buildOrphanedRunsSweeper();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await sweeper.execute([]);
    expect(result.scanned).toBe(0);
    expect(result.enqueued).toBe(0);
  });
});
```

- [ ] **Step 4.2: Run the new test to confirm it fails**

Run: `pnpm --filter @ai-sdlc/api test -- compose-sweep-waiting.test.ts`
Expected: FAIL — `c.buildOrphanedRunsSweeper` is `undefined`.

- [ ] **Step 4.3: Add the import to compose.ts**

In `apps/api/src/compose.ts`, in the existing `from '@ai-sdlc/application'` import block (around line 57), add `OrphanedRunsSweeper` immediately after the `WaitingRunsSweeper` line:

```ts
WaitingRunsSweeper,
OrphanedRunsSweeper,
```

- [ ] **Step 4.4: Add buildOrphanedRunsSweeper to the Container interface**

In the `Container` interface (around line 466), add this field directly after `buildWaitingRunsSweeper`:

```ts
buildOrphanedRunsSweeper: () => import('@ai-sdlc/application').OrphanedRunsSweeper;
```

- [ ] **Step 4.5: Add the factory function in compose.ts**

In the region where `buildWaitingRunsSweeper` is defined (around line 4033), add the new factory immediately after it (and before `workerLoopDeps`):

```ts
const buildOrphanedRunsSweeper = () =>
  new OrphanedRunsSweeper({
    runRepository,
    leases: workerLeaseRepository,
    queue: jobQueue,
    eventBus,
    now: () => new Date(),
    logger: sweepLogger,
  });
```

- [ ] **Step 4.6: Expose the factory on the returned container**

In the return object near line 4613, add the new field right after `buildWaitingRunsSweeper`:

```ts
buildWaitingRunsSweeper,
buildOrphanedRunsSweeper,
```

- [ ] **Step 4.7: Run the new test to confirm it passes**

Run: `pnpm --filter @ai-sdlc/api test -- compose-sweep-waiting.test.ts`
Expected: PASS — `buildOrphanedRunsSweeper` is now defined and returns a working sweeper.

- [ ] **Step 4.8: Verify no regressions in compose tests**

Run: `pnpm -r typecheck`
Run: `pnpm depcruise`
Run: `pnpm --filter @ai-sdlc/api test -- compose-sweep-waiting.test.ts`
Expected: PASS. Existing `WaitingRunsSweeper` wiring tests still pass.

- [ ] **Step 4.9: Commit**

```bash
git add apps/api/src/compose.ts apps/api/src/__tests__/compose-sweep-waiting.test.ts
git commit -m "feat(api): expose buildOrphanedRunsSweeper factory on Container"
```

---

