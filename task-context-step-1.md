# Task Context: Task 1

Title: Extend SweepOrphanedRuns return type to expose swept run records
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

- Modify: `packages/application/src/sweep-orphaned-runs.ts`
- Test: `packages/application/src/__tests__/sweep-orphaned-runs.test.ts`

- [ ] **Step 1.1: Write failing tests for the new return shape**

In `packages/application/src/__tests__/sweep-orphaned-runs.test.ts`, replace the existing `it('marks runs whose PID is dead as failed')` with two tests. The first keeps the old assertion on `result.swept === 1` and `repo.updates[0]!.patch.status === 'failed'`. Add a second test that asserts `result.orphanedRuns` contains the swept entry with `uuid` and `previousPid`:

```ts
import { describe, expect, it } from 'vitest';
import { SweepOrphanedRuns } from '../sweep-orphaned-runs.js';
import { FakeRunRepository } from '../test-doubles/fake-run-repository.js';
import { canResume, RepositoryId } from '@ai-sdlc/domain';
import { planRunRecoveryAction, type RunRecord } from '../index.js';

const fixedNow = () => new Date('2026-05-13T19:23:00Z');

describe('SweepOrphanedRuns', () => {
  it('returns orphaned run entries so callers can re-enqueue them', () => {
    const repo = new FakeRunRepository();
    repo.addRun({
      uuid: 'orphan-1',
      displayId: 'issue-1-20260513-000000',
      issueNumber: 1,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
      pid: 99999,
    });
    const isProcessAlive = (pid: number) => pid !== 99999;
    const usecase = new SweepOrphanedRuns({ runRepository: repo, isProcessAlive, now: fixedNow });
    const result = usecase.execute();
    expect(result.swept).toBe(1);
    expect(result.orphanedRuns).toHaveLength(1);
    expect(result.orphanedRuns[0]!.uuid).toBe('orphan-1');
    expect(result.orphanedRuns[0]!.previousPid).toBe(99999);
  });

  it('does not include runs that are still alive in orphanedRuns', () => {
    const repo = new FakeRunRepository();
    repo.addRun({
      uuid: 'alive-1',
      displayId: 'issue-2-20260513-000000',
      issueNumber: 2,
      type: 'issue_to_pr',
      status: 'running',
      completedPhases: [],
      startedAt: new Date('2026-05-13T18:00:00Z'),
      pid: 1234,
    });
    const isProcessAlive = () => true;
    const usecase = new SweepOrphanedRuns({ runRepository: repo, isProcessAlive, now: fixedNow });
    const result = usecase.execute();
    expect(result.swept).toBe(0);
    expect(result.orphanedRuns).toEqual([]);
  });
});
```

Keep every other existing test in the file as-is for now; their `result.swept` assertions still pass because `swept` will remain in the new result type.

- [ ] **Step 1.2: Run the new tests to confirm they fail**

Run: `pnpm --filter @ai-sdlc/application test -- sweep-orphaned-runs.test.ts`
Expected: FAIL — `result.orphanedRuns` is `undefined`, so `.toHaveLength(1)` and `.toEqual([])` both throw.

- [ ] **Step 1.3: Implement the new return type in `SweepOrphanedRuns`**

In `packages/application/src/sweep-orphaned-runs.ts`, replace the file contents with:

```ts
import type { RunRecord, RunRepositoryPort } from './ports.js';

export interface SweepOrphanedRunEntry {
  uuid: string;
  run: RunRecord;
  previousPid: number;
}

export interface SweepOrphanedRunsResult {
  scanned: number;
  swept: number;
  orphanedRuns: SweepOrphanedRunEntry[];
}

export interface SweepOrphanedRunsDeps {
  runRepository: RunRepositoryPort;
  isProcessAlive: (pid: number) => boolean;
  now?: () => Date;
}

export class SweepOrphanedRuns {
  constructor(private readonly deps: SweepOrphanedRunsDeps) {}

  execute(): SweepOrphanedRunsResult {
    const now = this.deps.now ?? (() => new Date());
    const activeRuns = this.deps.runRepository.findActiveRuns();
    const orphanedRuns: SweepOrphanedRunEntry[] = [];

    for (const run of activeRuns) {
      if (run.pid === undefined || run.pid === null) {
        continue;
      }
      if (!this.deps.isProcessAlive(run.pid)) {
        const previousPid = run.pid;
        const completedAt = now();
        this.deps.runRepository.updateStatusByUuid(run.uuid, {
          status: 'failed',
          completedAt,
          failureReason: `orphaned: process ${run.pid} no longer running`,
          currentPhase: null,
        });
        orphanedRuns.push({
          uuid: run.uuid,
          run: { ...run, status: 'failed', completedAt },
          previousPid,
        });
      }
    }

    return {
      scanned: activeRuns.length,
      swept: orphanedRuns.length,
      orphanedRuns,
    };
  }
}

export function checkPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}
```

- [ ] **Step 1.4: Re-run the new tests to confirm they pass**

Run: `pnpm --filter @ai-sdlc/application test -- sweep-orphaned-runs.test.ts`
Expected: PASS — both new tests pass and the previously-passing tests still pass (`result.swept` still exists).

- [ ] **Step 1.5: Verify no other callers broke**

Run: `pnpm --filter @ai-sdlc/application typecheck`
Run: `pnpm depcruise`
Expected: PASS. The only in-repo caller of `SweepOrphanedRuns.execute()` is `apps/api/src/compose.ts:1304` and it only reads `sweepResult.swept`, which still exists.

- [ ] **Step 1.6: Commit**

```bash
git add packages/application/src/sweep-orphaned-runs.ts packages/application/src/__tests__/sweep-orphaned-runs.test.ts
git commit -m "feat(application): SweepOrphanedRuns returns swept run entries"
```

---

