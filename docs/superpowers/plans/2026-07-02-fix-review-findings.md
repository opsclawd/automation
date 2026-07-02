# Fix Code Review Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all legitimate findings from `code-review.md` in the automation orchestrator project.

**Architecture:** 
1. Release worker lease on CLI exit (SIGINT/SIGTERM) in `apps/api/src/cli.ts`.
2. Filter hostname checks in `isWorkerAlive` in `apps/api/src/compose.ts`.
3. Stop swallowing failures in `WorkerScheduler` in `apps/api/src/worker-scheduler.ts` and propagate them.
4. Catch startup/setup exceptions (like `insertIfNoActive` or queue/worker registry errors) gracefully in the TS executor command path in `apps/api/src/cli.ts`.

**Tech Stack:** TypeScript, Node.js, Vitest

## Global Constraints
- Do not ask questions.
- Do not switch branches.
- Keep all work on the current branch.
- Run `git add -A && git commit -m "fix: review findings"` when complete.
- Write `result.json` last.

---

### Task 1: Clean up worker lease on CLI process exit (SIGINT/SIGTERM)

**Files:**
- Modify: `apps/api/src/cli.ts`

**Interfaces:**
- Consumes: `c.workerLeaseRepository` from Container
- Produces: Worker lease released on process termination via `SIGINT`/`SIGTERM`

- [ ] **Step 1: Update signal handler to release worker lease**
Inside `apps/api/src/cli.ts`, modify the `handleSignal` function inside the `ts` executor run action block to release the lease prior to calling `process.exit(exitCode)`.
```typescript
          const handleSignal = (signal: string, exitCode: number) => {
            abortController.abort();
            const currentJob = c.jobQueue.findById(jobId);
            if (currentJob && !['succeeded', 'failed', 'cancelled'].includes(currentJob.status)) {
              c.jobQueue.markCancelled(jobId, new Date());
            }
            const currentRun = c.runRepository.findByUuid(run.uuid);
            if (currentRun && currentRun.status === 'running') {
              c.runRepository.update(run.uuid, {
                status: 'cancelled',
                completedAt: new Date(),
                failureReason: `interrupted by ${signal}`,
              });
            }
            try {
              c.workerLeaseRepository.release(repoId, workerId);
            } catch (err) {
              console.error(
                `Failed to release lease on exit: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            unsubscribe?.();
            process.exit(exitCode);
          };
```

- [ ] **Step 2: Verify existing tests pass**
Run: `pnpm test`
Expected: All tests pass.

---

### Task 2: Hostname filtering in `isWorkerAlive`

**Files:**
- Modify: `apps/api/src/compose.ts`

**Interfaces:**
- Consumes: `workerRegistry.findById`, `os.hostname()`, `checkPid`
- Produces: `isWorkerAlive` returns `true` for remote workers without calling `checkPid`

- [ ] **Step 1: Add import for `os`**
Add `import os from 'node:os';` near the top of `apps/api/src/compose.ts`.

- [ ] **Step 2: Update `isWorkerAlive` function**
Modify the `isWorkerAlive` function under `workerLoopDeps` creation:
```typescript
          isWorkerAlive: (workerId) => {
            const w = workerRegistry.findById(workerId);
            if (!w) return false;
            if (w.hostname !== os.hostname()) {
              return true;
            }
            return checkPid(w.processId);
          },
```

- [ ] **Step 3: Verify existing tests pass**
Run: `pnpm test`
Expected: All tests pass.

---

### Task 3: Handle worker loop failures in `WorkerScheduler`

**Files:**
- Modify: `apps/api/src/worker-scheduler.ts`
- Modify: `apps/api/src/__tests__/worker-scheduler.test.ts`

**Interfaces:**
- Consumes: Results of `Promise.allSettled` in `WorkerScheduler.runUntilComplete`
- Produces: Propagates the first rejected reason if any worker loop fails

- [ ] **Step 1: Update `WorkerScheduler.runUntilComplete`**
Replace the line:
```typescript
      await Promise.allSettled(this.workerIds.map((wid) => workerLoop(wid, deps)));
```
with:
```typescript
      const results = await Promise.allSettled(this.workerIds.map((wid) => workerLoop(wid, deps)));
      for (const result of results) {
        if (result.status === 'rejected') {
          throw result.reason;
        }
      }
```

- [ ] **Step 2: Add unit test in `apps/api/src/__tests__/worker-scheduler.test.ts`**
Add a test asserting that `WorkerScheduler.runUntilComplete` propagates worker loop failures:
```typescript
  it('throws error when a worker loop rejects', async () => {
    const queue = makeQueue({});
    const scheduler = new WorkerScheduler([WorkerId('w1')], { ...makeBaseDeps(), queue }, queue, 0);
    vi.mocked(workerLoop).mockRejectedValueOnce(new Error('worker loop failure'));
    await expect(
      scheduler.runUntilComplete(JobId('job-1'), new AbortController().signal),
    ).rejects.toThrow('worker loop failure');
  });
```

- [ ] **Step 3: Run the new tests**
Run: `pnpm --filter @ai-sdlc/api test`
Expected: The new test passes, and the rest of the tests pass.

---

### Task 4: Catch setup/startup errors and exit cleanly with user error code

**Files:**
- Modify: `apps/api/src/cli.ts`
- Modify: `apps/api/src/__tests__/cli.test.ts`

**Interfaces:**
- Consumes: Setup steps in `run` command TS path
- Produces: CLI exits with exit code `1` (EXIT_USER_ERROR) and log message when setup fails

- [ ] **Step 1: Restructure the TS executor path in `apps/api/src/cli.ts`**
Move the initialization code into the main `try/catch` block. Define the handler functions and variables before `try` or adjust references so they are safely unregistered in `catch` and `finally` only if they were initialized.
Lines around 244–349 should look like:
```typescript
          const startedAt = new Date();
          const ids = newRunId({ issueNumber: opts.issue, now: startedAt });
          const repoId = RepositoryId(c.repoFullName);
          const run = createRun({
            uuid: ids.uuid,
            displayId: ids.displayId,
            repoId,
            issueNumber: opts.issue,
            startedAt,
          });

          const jobId = JobId(randomUUID());
          const workerId = WorkerId(`cli-${process.pid}`);
          const abortController = new AbortController();

          let unsubscribe: (() => void) | undefined;
          let sigintHandler: (() => void) | undefined;
          let sigtermHandler: (() => void) | undefined;

          try {
            c.runRepository.insertIfNoActive(run);

            const job = createJob({
              id: jobId,
              runId: RunId(run.uuid),
              repoId,
              issueNumber: IssueNumber(opts.issue),
              priority: 0,
              createdAt: startedAt,
            });
            c.jobQueue.enqueue({ job });

            c.workerRegistry.register(
              createWorker({
                id: workerId,
                hostname: os.hostname(),
                processId: process.pid,
                now: startedAt,
              }),
            );

            if (tee) {
              unsubscribe = c.eventBus.subscribe(ids.uuid, (event) => {
                console.error(`[ts] ${event.message}`);
              });
            }

            const handleSignal = (signal: string, exitCode: number) => {
              abortController.abort();
              const currentJob = c.jobQueue.findById(jobId);
              if (currentJob && !['succeeded', 'failed', 'cancelled'].includes(currentJob.status)) {
                c.jobQueue.markCancelled(jobId, new Date());
              }
              const currentRun = c.runRepository.findByUuid(run.uuid);
              if (currentRun && currentRun.status === 'running') {
                c.runRepository.update(run.uuid, {
                  status: 'cancelled',
                  completedAt: new Date(),
                  failureReason: `interrupted by ${signal}`,
                });
              }
              try {
                c.workerLeaseRepository.release(repoId, workerId);
              } catch (err) {
                console.error(
                  `Failed to release lease on exit: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
              unsubscribe?.();
              process.exit(exitCode);
            };

            sigintHandler = () => handleSignal('SIGINT', EXIT_SIGINT);
            sigtermHandler = () => handleSignal('SIGTERM', EXIT_SIGTERM);
            process.once('SIGINT', sigintHandler);
            process.once('SIGTERM', sigtermHandler);

            const scheduler = new WorkerScheduler([workerId], c.workerLoopDeps, c.jobQueue);

            await scheduler.runUntilComplete(jobId, abortController.signal);

            if (sigintHandler) process.off('SIGINT', sigintHandler);
            if (sigtermHandler) process.off('SIGTERM', sigtermHandler);

            const finalRun = c.runRepository.findByUuid(run.uuid) ?? run;
            const finalJob = c.jobQueue.findById(jobId);

            if (finalRun.status === 'passed') {
              const worktreePath = join(repoRoot, '.ai-worktrees', `issue-${opts.issue}`);
              try {
                await c.git.removeWorktree(worktreePath);
              } catch {
                // best-effort
              }
            }

            await new Promise<void>((resolve, reject) =>
              process.stdout.write(JSON.stringify({ run: finalRun, phases: [] }) + '\n', (err) =>
                err ? reject(err) : resolve(),
              ),
            );

            unsubscribe?.();
            const pausedStatuses: RunStatus[] = ['waiting', 'queued'];
            const isSuccess =
              finalRun.status === 'passed' ||
              pausedStatuses.includes(finalRun.status) ||
              finalJob?.status === 'succeeded';
            process.exit(isSuccess ? 0 : EXIT_USER_ERROR);
          } catch (err) {
            if (sigintHandler) process.off('SIGINT', sigintHandler);
            if (sigtermHandler) process.off('SIGTERM', sigtermHandler);
            unsubscribe?.();
            console.error(err instanceof Error ? err.message : String(err));
            process.exit(EXIT_USER_ERROR);
          }
```

- [ ] **Step 2: Update the `cli.test.ts` test assertion**
In `apps/api/src/__tests__/cli.test.ts`, update the test on line 1719 to expect `1` (which is `EXIT_USER_ERROR`) instead of `2`.
```typescript
  it('exits 1 when insertIfNoActive throws (user/setup error, scheduler never started)', async () => {
```
and:
```typescript
      expect(exitSpy.mock.calls[0]?.[0]).toBe(1);
```

- [ ] **Step 3: Verify all tests run and pass**
Run: `pnpm test` and `pnpm lint` and `pnpm typecheck`
Expected: Everything compiles, checks, and passes.
