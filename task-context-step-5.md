# Task Context: Task 5

Title: Run OrphanedRunsSweeper in the startup sweep block of composeRoot
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

- Modify: `apps/api/src/compose.ts:1298-1368` (the `runStartupSweeps` block)

- [ ] **Step 5.1: Extend the startup sweep block**

In `apps/api/src/compose.ts`, find the `if (opts.runStartupSweeps !== false) { ... }` block (around line 1298). It currently:

1. Runs `new SweepOrphanedRuns(...)` once and logs `"Recovered N orphaned run(s)"`.
2. Calls `sweepOrphanedTmpDirs(...)`.
3. Reaps orphaned test workers.
4. Fires a fire-and-forget `new SweepWaitingRuns(...).execute()` and logs `"Reactivation sweep: ..."`.

Modify the step-1 `SweepOrphanedRuns.execute()` invocation to capture the result and then run the new `OrphanedRunsSweeper` synchronously when there are entries to process. Replace the existing `SweepOrphanedRuns` portion of the block with:

```ts
const sweep = new SweepOrphanedRuns({
  runRepository,
  isProcessAlive: checkPid,
});
const sweepResult = sweep.execute();
if (sweepResult.swept > 0) {
  console.error(
    `Recovered ${sweepResult.swept} orphaned run(s); enqueuing resume jobs`,
  );
  if (sweepResult.orphanedRuns.length > 0) {
    const orphanSweeper = new OrphanedRunsSweeper({
      runRepository,
      leases: workerLeaseRepository,
      queue: jobQueue,
      eventBus,
      now: () => new Date(),
      logger: sweepLogger,
    });
    orphanSweeper
      .execute(sweepResult.orphanedRuns)
      .then((orphanResult) => {
        if (
          orphanResult.enqueued > 0 ||
          orphanResult.skippedLeaseConflict > 0 ||
          orphanResult.skippedAlreadyQueued > 0 ||
          orphanResult.enqueueErrors.length > 0
        ) {
          console.error(
            `Orphan recovery: ${orphanResult.enqueued} enqueued, ${orphanResult.skippedLeaseConflict} skipped (lease), ${orphanResult.skippedAlreadyQueued} skipped (already queued), ${orphanResult.enqueueErrors.length} errors`,
          );
          for (const err of orphanResult.enqueueErrors) {
            console.error(`  Orphan enqueue error in run ${err.runId}: ${err.error}`);
          }
        }
      })
      .catch((err) => {
        console.error('Orphan recovery sweep error:', err);
      });
  }
}
```

Leave the rest of the block (tmp dir sweep, test worker reap, waiting-runs sweep) untouched.

- [ ] **Step 5.2: Verify the startup wiring still typechecks and works for both happy and zero-orphan paths**

Run: `pnpm --filter @ai-sdlc/api typecheck`
Run: `pnpm --filter @ai-sdlc/api test -- compose-sweep-waiting.test.ts`
Run: `pnpm --filter @ai-sdlc/application test -- sweep-orphaned-runs.test.ts`
Expected: PASS — no signature or wiring breakage.

- [ ] **Step 5.3: Commit**

```bash
git add apps/api/src/compose.ts
git commit -m "feat(api): run OrphanedRunsSweeper during startup sweep when orphans exist"
```

---

