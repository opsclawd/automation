---
title: Orchestrator ENOSPC on tmpfs /tmp — redirect temp writes to project-local .ai-tmp/
date: 2026-05-20
category: runtime-errors
module: orchestrator
problem_type: runtime_error
component: tooling
symptoms:
  - Mid-phase ENOSPC ("No space left on device") despite df -h / showing ample free disk
  - df -h /tmp shows tmpfs at 100%
  - Run halts in inconsistent state with stuck running row in SQLite
  - ~10K stale /tmp/ai-orch-cfg-* directories accumulating across invocations
root_cause: incomplete_setup
resolution_type: code_fix
severity: critical
tags:
  - tmpfs
  - enospc
  - tmpdir
  - sqlite
  - orchestration
  - cleanup
related_components:
  - start-issue-run
  - compose
  - ports
---

# Orchestrator ENOSPC on tmpfs /tmp — redirect temp writes to project-local .ai-tmp/

## Problem

Long orchestrator runs fail with `ENOSPC` ("No space left on device") on systems where `/tmp` is a tmpfs (RAM-backed), which is the default on Manjaro, Arch, recent Fedora, and recent Ubuntu. This affects most contributor machines, not just CI.

The orchestrator and its child agents inherit the system `$TMPDIR` (defaults to `/tmp`) and write large intermediate state there: agent transcripts (hundreds of MB to GB), SQLite temp/journal/spill files, Node `os.tmpdir()` writes, and pnpm extraction during worktree bootstrap. On tmpfs, `/tmp` is typically sized to ~50% of RAM, and a single ambitious run can exhaust it.

Confirmed leaks from a 2026-05-19 cleanup session:

- ~10,000 stale `/tmp/ai-orch-cfg-*` directories (one per invocation, never cleaned up)
- 759 orphan `/tmp/.fb*-00000000.so` Node/V8 code-cache files at 8MB each (~6GB total)
- `/tmp/.pnpm-store` landing on tmpfs (649MB)

## Symptoms

- `ENOSPC` error mid-run while `df -h /` shows plenty of free space
- `df -h /tmp` shows tmpfs at 100%
- Orchestrator run halts in inconsistent state (compounds with issue #37: stuck `running` rows in SQLite)
- Stale `/tmp/ai-orch-cfg-*` directories accumulating across invocations

## What Didn't Work

- **Relying on OS `/tmp` cleanup**: OS tmpfs cleanup is periodic and unreliable; between cleanup cycles, tmpfs fills up during long orchestrator runs.
- **Manual `TMPDIR=` workaround**: Works but requires every operator to remember to set it before every invocation. No guard against forgetting.

## Solution

Created a project-local `.ai-tmp/` directory that redirects all temp file writes away from system `/tmp`:

### 1. New port types in `packages/application/src/ports.ts`

```typescript
export interface TmpDirectoryHandle {
  readonly tmpDir: string;
  remove(): void;
}

export type TmpDirectoryFactory = (input: {
  baseTmpDir: string;
  runId: string;
}) => TmpDirectoryHandle;
```

`TmpDirectoryHandle` follows the same pattern as `RunDirectoryHandle` — a factory returns a handle with a path and a cleanup method. The `remove()` method cleans up the per-run tmp dir when the run reaches terminal status.

### 2. Env var injection in `packages/application/src/start-issue-run.ts`

Two new deps on `StartIssueRunDeps`:

```typescript
baseTmpDir: string;
tmpDirectoryFactory: TmpDirectoryFactory;
```

In `execute()`, after building the env dict, the use case creates a per-run tmp dir handle and injects `TMPDIR` and `SQLITE_TMPDIR`:

```typescript
const tmpDirHandle = this.deps.tmpDirectoryFactory({
  baseTmpDir: this.deps.baseTmpDir,
  runId: run.uuid,
});
env.TMPDIR = tmpDirHandle.tmpDir;
env.SQLITE_TMPDIR = tmpDirHandle.tmpDir;
```

Cleanup happens in the `finally` block to ensure the directory is removed regardless of success or failure:

```typescript
} finally {
  try {
    tmpDirHandle.remove();
  } catch (e) {
    logger.error('Failed to remove run tmp directory', e);
  }
}
```

Both `TMPDIR` and `SQLITE_TMPDIR` are set because SQLite ignores `TMPDIR` on some platforms (macOS, some Linux configs).

### 3. Composition root wiring in `apps/api/src/compose.ts`

```typescript
const envTmpdir = process.env.TMPDIR?.trim();
const baseTmpDir = envTmpdir ? join(envTmpdir, '.ai-tmp') : join(opts.repoRoot, '.ai-tmp');
mkdirSync(baseTmpDir, { recursive: true });
```

The `tmpDirectoryFactory` implementation:

```typescript
const tmpDirectoryFactory: TmpDirectoryFactory = ({ baseTmpDir: base, runId }) => {
  const tmpDir = join(base, runId);
  mkdirSync(tmpDir, { recursive: true });
  return {
    tmpDir,
    remove() {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
};
```

Startup sweep of orphaned tmp dirs (mirrors the existing `SweepOrphanedRuns` pattern):

```typescript
function sweepOrphanedTmpDirs(baseTmpDir: string, runRepository: RunRepositoryPort): void {
  if (!existsSync(baseTmpDir)) return;
  const entries = readdirSync(baseTmpDir);
  for (const entry of entries) {
    const entryPath = join(baseTmpDir, entry);
    try {
      const stat = statSync(entryPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const record = runRepository.findByUuid(entry);
    if (!record || ['passed', 'failed', 'cancelled'].includes(record.status)) {
      try {
        rmSync(entryPath, { recursive: true, force: true });
      } catch {
        // Best-effort: if removal fails, leave for next sweep
      }
    }
  }
}
```

### 4. `.gitignore` entry

Added `.ai-tmp/` explicitly after the existing `.ai-runs/` line — even though `.ai-*` patterns might cover it, being explicit makes intent clear.

## Why This Works

1. **Project-local storage avoids tmpfs entirely**: The `.ai-tmp/` directory sits in the project root, which is typically on a real filesystem (not tmpfs). Temp writes go to disk, not RAM.

2. **Per-run isolation**: Each run gets `.ai-tmp/<runId>/`, creating clean isolation between runs and enabling targeted cleanup.

3. **Three-layer cleanup prevents leaks**:
   - **Eager cleanup**: `tmpDirHandle.remove()` in the `finally` block of `StartIssueRun.execute()` (works for normal exits and errors)
   - **Startup sweep**: `sweepOrphanedTmpDirs()` in `composeRoot` catches orphaned dirs from SIGKILL'd processes or crashed runs
   - **Terminal-state sweep**: The startup sweep also removes dirs whose runs are in terminal states (`passed`, `failed`, `cancelled`)

4. **Operator override preserved**: If `TMPDIR` is already set in the environment, it's respected as the base: `process.env.TMPDIR/.ai-tmp/<runId>`. Per-run isolation and cleanup still work regardless of base path.

5. **Concurrent-safe**: `mkdirSync(dir, { recursive: true })` is a no-op if the directory already exists, so multiple concurrent orchestrator instances don't race.

6. **Layer boundaries preserved**: The application layer defines `TmpDirectoryFactory` and `TmpDirectoryHandle` as ports in `ports.ts`. The composition root (`compose.ts`) provides the implementation. No application-to-infrastructure import needed.

## Prevention

- **Typecheck enforces port coverage**: `baseTmpDir` and `tmpDirectoryFactory` are required deps on `StartIssueRunDeps`. Missing them causes a compile error, not a silent default to `/tmp`.
- **`pnpm depcruise` enforces layer boundaries**: The application layer never imports infrastructure. The port pattern keeps filesystem operations in the composition root.
- **Integration tests verify env propagation**: Tests in `compose.test.ts` verify that `TMPDIR` and `SQLITE_TMPDIR` are set in child process environments and that per-run dirs are created and cleaned up.

## Gotchas and Pitfalls

- **SIGKILL cleanup gap**: If the orchestrator is force-killed, `tmpDirHandle.remove()` won't run. The startup sweep handles this case by removing directories whose runs are in terminal state or missing from the database. This is best-effort — if the process is killed before the DB records terminal status, the sweep leaves the directory until the next startup after the DB is corrected.

- **Operator TMPDIR between runs**: If an operator changes `TMPDIR` between runs, stale dirs from the old path won't be swept. This is acceptable — the old path is the operator's responsibility. The orchestrator only sweeps its own current `baseTmpDir`.

- **`SQLITE_TMPDIR` vs `TMPDIR`**: Both must be set. SQLite on some platforms (macOS, certain Linux configs) ignores `TMPDIR` and uses `SQLITE_TMPDIR` instead. Setting both ensures SQLite temp files also land in the project-local directory.

- **Every `StartIssueRun` test must provide `baseTmpDir` and `tmpDirectoryFactory`**: These are required deps. A helper `fakeTmpDir` is used in tests:
  ```typescript
  const fakeTmpDir = (input: { baseTmpDir: string; runId: string }) => ({
    tmpDir: `${input.baseTmpDir}/${input.runId}`,
    remove() {},
  });
  ```

## Related Issues

- #37 — Orchestrator leaves run rows stuck in `running` on crash. Same class of bug: orchestrator-owned state lifecycle gaps.
- #49 — Stabilize legacy orchestrator before M3/M4. This fix belongs in the pre-M3 stabilization bucket.
