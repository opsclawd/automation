# Target Repo Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--target-repo-root <path>` to the `run` CLI command so the orchestrator can operate against a different repository checkout while keeping all config, prompts, and scripts in the automation repo.

**Architecture:** Introduce `targetRepoRoot?: string` to `ComposeOptions`. Resolve a single `targetRoot = opts.targetRepoRoot ?? opts.repoRoot` at the top of `composeRoot` and substitute it for `opts.repoRoot` in the four storage/git paths (runsDir default, worktree path, two `gh repo view` cwd calls). All other `opts.repoRoot` references (prompts, config, scripts) are unchanged.

**Tech Stack:** TypeScript (strict, ESM), Commander.js, Vitest.

---

### Task 1: Add `targetRepoRoot` to `ComposeOptions` and resolve `targetRoot`

**Files:**
- Modify: `apps/api/src/compose.ts`

- [ ] **Step 1:** Add the field to `ComposeOptions` (around line 416, after `repoFullName`):

```ts
/** Target repository root. When set, worktrees, DB, and runs dir are
 *  created here instead of repoRoot. Config, prompts, and scripts always
 *  come from repoRoot. */
targetRepoRoot?: string;
```

- [ ] **Step 2:** Resolve `targetRoot` at the top of `composeRoot`, immediately after the existing `const runsDir` line (line ~661). Insert before `const runsDir`:

```ts
const targetRoot = opts.targetRepoRoot ?? opts.repoRoot;
```

- [ ] **Step 3:** Switch `runsDir` default to use `targetRoot` (line ~661):

```ts
const runsDir = opts.runsDir ?? join(targetRoot, '.ai-runs');
```

- [ ] **Step 4:** Switch the two worktree path derivations to use `targetRoot`.

At line ~759 (inside `contextFactory`):
```ts
return join(targetRoot, '.ai-worktrees', `issue-${run.issueNumber}`);
```

At line ~1450 (inside `buildContext`):
```ts
const cwd = join(targetRoot, '.ai-worktrees', `issue-${run.issueNumber}`);
```

- [ ] **Step 5:** Switch both `gh repo view` `cwd` calls to use `targetRoot`.

At line ~776 (start-commit SHA resolution):
```ts
{ cwd: targetRoot },
```

At line ~858 (repoFullName resolution):
```ts
{ cwd: targetRoot },
```

- [ ] **Step 6:** Switch the git adapter `localBasePath` to use `targetRoot` (line ~2069):

```ts
localBasePath: targetRoot,
```

- [ ] **Step 7:** Verify `promptsRoot` (line ~1467) still reads from `opts.repoRoot` — do NOT change it:

```ts
promptsRoot: join(opts.repoRoot, 'prompts'),
```

- [ ] **Step 8:** Run typecheck to confirm no type errors:

```bash
pnpm --filter @ai-sdlc/api typecheck
```

Expected: no errors.

- [ ] **Step 9:** Commit:

```bash
git add apps/api/src/compose.ts
git commit -m "feat(compose): add targetRepoRoot option to ComposeOptions"
```

---

### Task 2: Add `--target-repo-root` to the `run` CLI command

**Files:**
- Modify: `apps/api/src/cli.ts`

- [ ] **Step 1:** Locate the `RunCliOptions` interface (around line 150) and add the new field:

```ts
interface RunCliOptions {
  issue: number;
  baseBranch?: string;
  model?: string;
  agentCli?: string;
  script?: string;
  executor?: string;
  targetRepoRoot?: string;
}
```

- [ ] **Step 2:** Add the CLI option to the `run` command, after `--executor` (around line 186):

```ts
.option('--target-repo-root <path>', 'Target repository root for worktrees and DB (default: orchestrator repo)')
```

- [ ] **Step 3:** Wire it through to `ComposeOptions` in the `.action` handler, after the existing `if (opts.agentCli ...)` line (around line 205):

```ts
if (opts.targetRepoRoot !== undefined) options.targetRepoRoot = opts.targetRepoRoot;
```

- [ ] **Step 4:** Run typecheck:

```bash
pnpm --filter @ai-sdlc/api typecheck
```

Expected: no errors.

- [ ] **Step 5:** Smoke-test that help text shows the new flag:

```bash
pnpm --filter @ai-sdlc/api dev run --help
```

Expected output includes:
```
--target-repo-root <path>   Target repository root for worktrees and DB (default: orchestrator repo)
```

- [ ] **Step 6:** Commit:

```bash
git add apps/api/src/cli.ts
git commit -m "feat(cli): add --target-repo-root to run command"
```

---

### Task 3: Validate the target path at startup

**Files:**
- Modify: `apps/api/src/cli.ts`

- [ ] **Step 1:** Add startup validation in the `run` command's `.action` handler, immediately after `const repoRoot = findRepoRoot(process.cwd())` (around line 189). Insert:

```ts
if (opts.targetRepoRoot !== undefined) {
  const targetRepoRoot = resolve(opts.targetRepoRoot);
  if (!existsSync(targetRepoRoot) || !statSync(targetRepoRoot).isDirectory()) {
    console.error(`Error: --target-repo-root path does not exist or is not a directory: ${targetRepoRoot}`);
    process.exit(EXIT_USER_ERROR);
  }
  try {
    execFileSync('git', ['-C', targetRepoRoot, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
  } catch {
    console.error(`Error: --target-repo-root is not a git repository: ${targetRepoRoot}`);
    process.exit(EXIT_USER_ERROR);
  }
  opts.targetRepoRoot = targetRepoRoot;
}
```

- [ ] **Step 2:** Confirm `existsSync`, `statSync`, `execFileSync`, and `resolve` are already imported at the top of `cli.ts`. If any are missing, add them to the existing import block:

```ts
import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
```

- [ ] **Step 3:** Run typecheck:

```bash
pnpm --filter @ai-sdlc/api typecheck
```

Expected: no errors.

- [ ] **Step 4:** Commit:

```bash
git add apps/api/src/cli.ts
git commit -m "feat(cli): validate --target-repo-root path and git repo at startup"
```

---

### Task 4: Unit tests

**Files:**
- Modify: `apps/api/src/__tests__/compose.test.ts`

- [ ] **Step 1:** Open `apps/api/src/__tests__/compose.test.ts` and find the `describe('composeRoot', ...)` block. Add a new `describe` block at the end of that block:

```ts
describe('targetRepoRoot', () => {
  it('uses targetRepoRoot for runsDir default when set', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-'));
    const target = mkdtempSync(join(tmpdir(), 'target-'));
    const scriptPath = join(root, 'script.sh');
    writeFileSync(scriptPath, '#!/bin/bash', 'utf-8');
    try {
      const container = composeRoot({
        repoRoot: root,
        scriptPath,
        targetRepoRoot: target,
        repoFullName: 'owner/repo',
      });
      expect(container.runsDir).toBe(join(target, '.ai-runs'));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('falls back to repoRoot for runsDir when targetRepoRoot is not set', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-'));
    const scriptPath = join(root, 'script.sh');
    writeFileSync(scriptPath, '#!/bin/bash', 'utf-8');
    try {
      const container = composeRoot({
        repoRoot: root,
        scriptPath,
        repoFullName: 'owner/repo',
      });
      expect(container.runsDir).toBe(join(root, '.ai-runs'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2:** Confirm `mkdtempSync`, `rmSync`, `writeFileSync`, `tmpdir`, and `join` are imported at the top of the test file. Add any that are missing:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

- [ ] **Step 3:** Run the new tests:

```bash
pnpm --filter @ai-sdlc/api test -- --reporter=verbose apps/api/src/__tests__/compose.test.ts
```

Expected: new tests PASS, existing tests unchanged.

- [ ] **Step 4:** Run the full test suite to check for regressions:

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 5:** Commit:

```bash
git add apps/api/src/__tests__/compose.test.ts
git commit -m "test(compose): verify targetRepoRoot drives runsDir derivation"
```

---

## Self-review

**Spec coverage:**
- ✓ `--target-repo-root` CLI flag → Task 2
- ✓ `targetRepoRoot` in `ComposeOptions` → Task 1
- ✓ `targetRoot` substituted for runsDir, worktrees, gh cwd, git localBasePath → Task 1
- ✓ Prompts/config/scripts stay on `repoRoot` → Task 1 step 7
- ✓ Path validation (exists, is directory, is git repo) → Task 3
- ✓ `--runs-dir` explicit override still wins (unchanged behaviour — `opts.runsDir` takes precedence in `const runsDir = opts.runsDir ?? join(targetRoot, '.ai-runs')`) → covered by existing tests
- ✓ Unit tests for `targetRepoRoot` → Task 4

**Placeholder scan:** None found.

**Type consistency:** `targetRepoRoot` is `string | undefined` in both `RunCliOptions` (Task 2) and `ComposeOptions` (Task 1). The `targetRoot` local variable is `string` (always resolved). Consistent throughout.
