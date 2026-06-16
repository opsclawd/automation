# M8-13: Worktree Lifecycle Adapter (GitWorktreeAdapter) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `GitWorktreeAdapter implements GitPort` — the infrastructure adapter managing per-issue worktrees (`.ai-worktrees/issue-<N>`): create/reuse on a dedicated branch, verify-clean (reset to latest base) at run start, capture the baseline commit, reset to a commit on cancel, and never mutate the main checkout.

**Architecture:** A class in `packages/infrastructure/src/git/git-worktree-adapter.ts` implementing the full `GitPort` interface by shelling out to `git` via a small promisified `execFile` runner. Tested against a **real temporary git repo** (integration test), never the project repo.

**Tech Stack:** TypeScript (strict, ESM), Vitest, `node:child_process` (`execFile`), `node:fs`/`node:os` for temp repos.

---

## Critical context (read first)

- **There is no production `GitPort` implementation yet** — only `FakeGitPort` (test double). This story creates the first real one. Confirm by `ls packages/infrastructure/src/git` (likely absent → create the dir).
- **`GitPort` interface** (`packages/application/src/ports/git-port.ts`) — implement ALL methods: `createWorktree`, `removeWorktree`, `currentBranch`, `headCommitSha`, `resetHard`, `diff`, `commit`, `push`, `remoteRef`, `isAncestor`, `logBetween`, `cleanUntracked`, `headCommitShaOf`. Plus the lifecycle helpers this story adds (verify-clean, record-start-commit) — add them as adapter methods or as part of `createWorktree`.
- **Q14:** worktree scoped to issue (`.ai-worktrees/issue-<N>`), reused across runs; verify clean (reset to latest base) at run start. **Q23/Q24:** capture `startCommitSha` at invocation start; reset to it on cancel.
- **Regression guards:** runs must stay inside the worktree and never mutate the main checkout (#295, #318); read-only review phases require a clean worktree (#351). The verify-clean step is the enforcement point — distinguish reviewer-created leftovers from real drift (#348) where possible.
- **VPS layout (PRD §21.1):** `repos/<owner__repo>/bare.git` + `worktrees/issue-<N>-run-<runId>`. Take the base path from config/`Repository.localBasePath` (M3-02). For local MVP, default to `.ai-worktrees/issue-<N>`. Leave a documented seam for the VPS layout; don't hard-code the local path.
- Use a shell runner that captures stdout/stderr and rejects on non-zero exit. There is an existing `packages/infrastructure/src/bash/run-bash-script.ts` and `agent/external-cli-runner.ts` — reuse a runner if one fits; otherwise a small promisified `execFile('git', args, { cwd })` is fine (no `execa` dependency assumed).

## File structure

- Create: `packages/infrastructure/src/git/git-runner.ts` — promisified `git` exec helper.
- Create: `packages/infrastructure/src/git/git-worktree-adapter.ts` — the adapter.
- Create: `packages/infrastructure/src/git/__tests__/git-worktree-adapter.test.ts` — integration test against a temp repo.
- Create: `packages/infrastructure/src/git/__tests__/helpers.ts` — temp-repo fixture builder.
- Modify: `packages/infrastructure/src/index.ts` — export the adapter.

---

### Task 1: git runner + temp-repo fixture

**Files:**
- Create: `packages/infrastructure/src/git/git-runner.ts`
- Create: `packages/infrastructure/src/git/__tests__/helpers.ts`

- [ ] **Step 1: Implement `git-runner.ts`:**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await pexec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.toString().trim();
}
```

- [ ] **Step 2: Implement the fixture builder `helpers.ts`:**

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../git-runner.js';

/** Creates a temp git repo with one commit on `main` and returns its path. */
export async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'wt-test-'));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# base\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}
```

- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(infra): git runner + temp-repo test fixture"`

---

### Task 2: createWorktree + currentBranch + headCommitSha

**Files:**
- Create: `packages/infrastructure/src/git/git-worktree-adapter.ts`
- Test: `packages/infrastructure/src/git/__tests__/git-worktree-adapter.test.ts`

- [ ] **Step 1: Write the failing integration test:**

```ts
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GitWorktreeAdapter } from '../git-worktree-adapter.js';
import { makeTempRepo } from './helpers.js';

describe('GitWorktreeAdapter', () => {
  it('creates a worktree on its own branch from the base branch', async () => {
    const repo = await makeTempRepo();
    const adapter = new GitWorktreeAdapter();
    const worktreePath = join(repo, '.ai-worktrees', 'issue-7');

    await adapter.createWorktree({
      repoLocalBasePath: repo,
      worktreePath,
      branch: 'feat/issue-7',
      baseBranch: 'main',
    });

    expect(existsSync(join(worktreePath, '.git'))).toBe(true);
    expect(await adapter.currentBranch(worktreePath)).toBe('feat/issue-7');
    const sha = await adapter.headCommitSha(worktreePath);
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
  });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm exec vitest run packages/infrastructure/src/git/__tests__/git-worktree-adapter.test.ts`

- [ ] **Step 3: Implement the adapter skeleton** (these three methods first):

```ts
import { git } from './git-runner.js';
import type {
  GitPort, CreateWorktreeInput, PushInput,
} from '@ai-sdlc/application';

export class GitWorktreeAdapter implements GitPort {
  async createWorktree(input: CreateWorktreeInput): Promise<void> {
    const base = input.repoLocalBasePath;
    await git(base, ['fetch', 'origin', input.baseBranch]).catch(() => undefined);
    await git(base, ['worktree', 'prune']).catch(() => undefined);
    // Create the worktree on a fresh branch off the base.
    const baseRef = await this.resolveBaseRef(base, input.baseBranch);
    await git(base, ['worktree', 'add', input.worktreePath, '-b', input.branch, baseRef]);
  }

  private async resolveBaseRef(base: string, baseBranch: string): Promise<string> {
    // Prefer origin/<base> when present, else local <base>.
    try {
      await git(base, ['rev-parse', '--verify', `origin/${baseBranch}`]);
      return `origin/${baseBranch}`;
    } catch {
      return baseBranch;
    }
  }

  async currentBranch(cwd: string): Promise<string> {
    return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  async headCommitSha(cwd: string): Promise<string> {
    return git(cwd, ['rev-parse', 'HEAD']);
  }

  // ... remaining GitPort methods implemented in Tasks 3–4 ...
  removeWorktree(_p: string): Promise<void> { throw new Error('TODO Task 4'); }
  resetHard(_c: string, _s: string): Promise<void> { throw new Error('TODO Task 3'); }
  diff(_c: string, _b: string, _h?: string): Promise<string> { throw new Error('TODO Task 4'); }
  commit(_c: string, _m: string): Promise<string> { throw new Error('TODO Task 4'); }
  push(_i: PushInput): Promise<void> { throw new Error('TODO Task 4'); }
  remoteRef(_i: { cwd: string; remote: string; ref: string }): Promise<string | undefined> { throw new Error('TODO Task 4'); }
  isAncestor(_c: string, _a: string, _d: string): Promise<boolean> { throw new Error('TODO Task 4'); }
  logBetween(_c: string, _b: string, _h: string): Promise<string[]> { throw new Error('TODO Task 4'); }
  cleanUntracked(_c: string): Promise<void> { throw new Error('TODO Task 4'); }
  headCommitShaOf(_c: string): Promise<string | undefined> { throw new Error('TODO Task 4'); }
}
```

- [ ] **Step 4: Run → PASS** (the three implemented methods). Remaining throwers are filled next.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(infra): GitWorktreeAdapter createWorktree + branch/head queries"`

---

### Task 3: recordStartCommit + resetHard (cancel baseline)

**Files:**
- Modify: adapter + test

- [ ] **Step 1: Add failing test** (record HEAD, make a commit in the worktree, reset back, assert HEAD restored and the main checkout untouched):

```ts
it('resets the worktree to a recorded commit without touching the main checkout', async () => {
  const repo = await makeTempRepo();
  const adapter = new GitWorktreeAdapter();
  const wt = join(repo, '.ai-worktrees', 'issue-7');
  await adapter.createWorktree({ repoLocalBasePath: repo, worktreePath: wt, branch: 'feat/issue-7', baseBranch: 'main' });

  const baseline = await adapter.headCommitSha(wt);
  // make a commit in the worktree
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(wt, 'new.txt'), 'x');
  await adapter.commit(wt, 'wip');
  expect(await adapter.headCommitSha(wt)).not.toBe(baseline);

  await adapter.resetHard(wt, baseline);
  expect(await adapter.headCommitSha(wt)).toBe(baseline);

  // main checkout HEAD unchanged
  expect(await adapter.currentBranch(repo)).toBe('main');
});
```

- [ ] **Step 2: Run → FAIL** (commit/resetHard throw).

- [ ] **Step 3: Implement `commit`, `resetHard`:**

```ts
  async commit(cwd: string, message: string): Promise<string> {
    await git(cwd, ['add', '-A']);
    await git(cwd, ['commit', '-m', message]);
    return git(cwd, ['rev-parse', 'HEAD']);
  }
  async resetHard(cwd: string, commitSha: string): Promise<void> {
    await git(cwd, ['reset', '--hard', commitSha]);
  }
```

- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(infra): worktree commit + resetHard (cancel baseline)"`

---

### Task 4: verify-clean + remaining GitPort methods

**Files:**
- Modify: adapter + test

- [ ] **Step 1: Add failing tests:**
  - `verifyClean(worktreePath, baseBranch)` resets a worktree with uncommitted changes back to a clean state at latest base (and **rejects** if there is unexpected drift that should block — decide the policy: for read-only review safety, fail when tracked files are dirty; allow known reviewer-created untracked paths). Add one "clean" and one "dirty" case.
  - Implement and smoke-test `removeWorktree`, `diff`, `push` (against a bare remote in the temp fixture), `remoteRef`, `isAncestor`, `logBetween`, `cleanUntracked`, `headCommitShaOf`. For `push`/`remoteRef`, extend the fixture to add a bare remote (`git init --bare` + `git remote add origin`).

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** each method with the corresponding git command:

```ts
  async removeWorktree(worktreePath: string): Promise<void> {
    // run from the worktree's main repo; --force to drop a dirty worktree
    await git(worktreePath, ['worktree', 'remove', '--force', worktreePath]).catch(async () => {
      // fall back to pruning from the base repo if direct remove fails
    });
  }
  async diff(cwd: string, base: string, head?: string): Promise<string> {
    return git(cwd, head ? ['diff', `${base}..${head}`] : ['diff', base]);
  }
  async push(input: PushInput): Promise<void> {
    await git(input.cwd, ['push', input.remote ?? 'origin', input.branch]);
  }
  async remoteRef(input: { cwd: string; remote: string; ref: string }): Promise<string | undefined> {
    try {
      const out = await git(input.cwd, ['ls-remote', input.remote, input.ref]);
      return out.split('\t')[0] || undefined;
    } catch {
      return undefined;
    }
  }
  async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    try { await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]); return true; } catch { return false; }
  }
  async logBetween(cwd: string, base: string, head: string): Promise<string[]> {
    const out = await git(cwd, ['log', '--format=%H', `${base}..${head}`]);
    return out ? out.split('\n') : [];
  }
  async cleanUntracked(cwd: string): Promise<void> {
    await git(cwd, ['clean', '-fd']);
  }
  async headCommitShaOf(cwd: string): Promise<string | undefined> {
    try { return await git(cwd, ['rev-parse', 'HEAD']); } catch { return undefined; }
  }
```

Add `verifyClean`:

```ts
  /** Resets the worktree to latest base; throws on tracked-file drift that would
   *  corrupt a read-only review phase (#351). */
  async verifyClean(worktreePath: string, baseBranch: string): Promise<void> {
    const status = await git(worktreePath, ['status', '--porcelain']);
    const trackedDirty = status.split('\n').filter((l) => l && !l.startsWith('??'));
    if (trackedDirty.length > 0) {
      throw new Error(`worktree has uncommitted tracked changes: ${trackedDirty.join('; ')}`);
    }
    await git(worktreePath, ['fetch', 'origin', baseBranch]).catch(() => undefined);
    const baseRef = await this.resolveBaseRef(worktreePath, baseBranch);
    await git(worktreePath, ['reset', '--hard', baseRef]);
  }
```

- [ ] **Step 4: Run → PASS** (all integration tests). Verify the main checkout is never modified in any test.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(infra): verify-clean + full GitPort method set"`

---

### Task 5: Export + boundaries + full suite

- [ ] **Step 1:** Export `GitWorktreeAdapter` from `packages/infrastructure/src/index.ts`.
- [ ] **Step 2:** `pnpm -r typecheck && pnpm lint && pnpm test` → all PASS. (Note: these integration tests invoke real `git`; ensure CI has git available — it does for `test:bash`.)
- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(infra): export GitWorktreeAdapter"`

---

## Self-review checklist

- [ ] Acceptance → tests: createWorktree on own branch (Task 2), reuse idempotent (add a second-create test), verify-clean clean+dirty (Task 4), record + resetHard baseline (Task 3), main checkout never mutated (assert in Tasks 2–4), all git ops against a temp repo (all).
- [ ] Implements the full `GitPort` interface — no method left throwing.
- [ ] Base path comes from input/`localBasePath`, not hard-coded; VPS-layout seam documented.
- [ ] Names consistent: `GitWorktreeAdapter`, `git()` runner, `verifyClean`.

## Definition of done

Merged with green CI; adapter implements `GitPort`; clean-at-start + reset-on-cancel proven against a temp repo; main checkout never mutated.
