# Code Review: ai/issue-1 vs origin/main

## Summary

Branch `ai/issue-1` implements M1-01: Bootstrap monorepo + tooling. The implementation correctly sets up a pnpm 9 TypeScript monorepo with workspaces, strict TypeScript config, Vitest, ESLint 9 flat config, and GitHub Actions CI. Five files outside the defined scope are also committed.

---

## Findings

### HIGH — Scope creep: documentation files committed that are outside the In Scope definition

**File:** `design.md` (157 lines)
**Evidence:** `git diff --stat` shows `design.md` as a new file with 157 additions.

**Failure mode:** The issue explicitly states "This issue should not change files outside the listed scope" and lists only: root config files, GitHub Actions workflow, packages, and apps. `design.md` is not in that list. These documentation artifacts belong in a separate issue or in the existing docs/ directory, not committed as part of the bootstrap.

**Required fix:** Remove `design.md` from the commit. If a design document is needed for the project, it should be created in a separate issue or PR.

---

### HIGH — Scope creep: implementation log committed

**File:** `implementation-log.md` (56 lines)
**Evidence:** `git diff --stat` shows `implementation-log.md` as a new file.

**Failure mode:** Implementation logs are working documents for agentic workers. The issue definition of done says "No app/domain code committed (this issue should not change files outside the listed scope)." This file is outside the listed scope and should not be part of the permanent commit history.

**Required fix:** Remove `implementation-log.md` from the commit.

---

### HIGH — Scope creep: issue comments document committed

**File:** `issue-comments.md` (365 lines)
**Evidence:** `git diff --stat` shows `issue-comments.md` as a new file with 365 lines.

**Failure mode:** This file appears to be a scratch pad or working document (note the "Automation failed: Issue body missing required section: Goal" appended at the end). It is not a project artifact — it has no legitimate reason to live in the repo permanently. Committing it pollutes the history and signals the implementation included out-of-scope work.

**Required fix:** Remove `issue-comments.md` from the commit.

---

### HIGH — Scope creep: issue.json committed

**File:** `issue.json` (1 line)
**Evidence:** `git diff --stat` shows `issue.json` as a new file with 1 line.

**Failure mode:** This appears to be a JSON serialization of the issue. It is not a project artifact needed for the monorepo bootstrap. If issue tracking is needed, GitHub Issues is the system of record — not a JSON file in the repo.

**Required fix:** Remove `issue.json` from the commit.

---

### HIGH — Scope creep: plan.md committed

**File:** `plan.md` (841 lines)
**Evidence:** `git diff --stat` shows `plan.md` as a new file with 841 lines.

**Failure mode:** The implementation plan is a working document for agentic execution. The issue explicitly states "No app/domain code committed (this issue should not change files outside the listed scope)." The plan.md is outside the listed scope. While plan.md exists in the worktree for the agent to follow, it should not be committed as part of this PR — future agents can regenerate it from issue.md.

**Required fix:** Remove `plan.md` from the commit.

---

### MEDIUM — Missing `apps/web/tsconfig.json`

**File:** `apps/web/tsconfig.json` (missing)
**Evidence:** `apps/web/package.json` exists but no `tsconfig.json` or `src/` directory. Only `apps/web/package.json` was created, with no `tsconfig.json`.

**Failure mode:** `apps/web` is a placeholder per the issue spec ("Next.js owns its own scaffolding later"). The issue also says "Do NOT create `apps/web/tsconfig.json` or any `src/` content yet — those land in Task 7." This is correct behavior — no fix required. Noted here for completeness only.

**Required fix:** None — this is correct per the issue spec.

---

### MEDIUM — `.gitignore` unchanged despite issue specifying `.gitignore` additions

**File:** `.gitignore`
**Evidence:** `git diff origin/main...HEAD -- .gitignore` shows no diff. Main already contains all entries required: `node_modules/`, `dist/`, `.next/`, `coverage/`, `*.tsbuildinfo`, `.ai-runs/`, `.ai-worktrees/`, `*.result`, `*.log`, `.DS_Store`.

**Failure mode:** The issue spec says to append entries to `.gitignore`, but main already has them. This is not a bug — the existing `.gitignore` already covers the requirements. However, it means the implementation didn't need to modify `.gitignore`, which is fine.

**Required fix:** None — this is correct behavior.

---

### LOW — ESLint flat config parser import naming

**File:** `eslint.config.mjs:306-307`
**Evidence:**
```js
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
```

**Failure mode:** The variable names `tseslint` and `tsparser` are unconventional. The standard import pattern for `@typescript-eslint/eslint-plugin` is to destructure the plugin:
```js
import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
```

However, `eslint` is imported as a default in the `@eslint/js` package, not from `eslint`. The config uses `eslint` from the `eslint` package (v9), which is correct. The naming `tseslint` and `tsparser` works but is nonstandard — most codebases use `tseslint` and `tsparser` or similar. This is a minor style issue.

**Required fix:** Optional: rename to `tseslintPlugin` and `tsparser` for clarity, but current naming is not incorrect.

---

### LOW — TypeScript version mismatch in issue vs implementation

**File:** `package.json:devDependencies.typescript`
**Evidence:** Issue says `typescript@^5.6.3` but plan says `typescript@5.6`. The diff shows `"typescript": "^5.6.3"`.

**Failure mode:** No failure — version `^5.6.3` is within the plan's `5.6` constraint and satisfies the issue's intent. Noted for clarity only.

**Required fix:** None.

---

## Out-of-Scope Files Summary

| File | Lines | Status |
|------|-------|--------|
| `design.md` | 157 | Should be removed |
| `implementation-log.md` | 56 | Should be removed |
| `issue-comments.md` | 365 | Should be removed |
| `issue.json` | 1 | Should be removed |
| `plan.md` | 841 | Should be removed |

Total out-of-scope additions: **1,420 lines**

---

## Correct Implementation Elements

The following are correctly implemented:

- `package.json` with correct `packageManager: "pnpm@9.12.3"` and devDependencies
- `pnpm-workspace.yaml` with correct workspace globs
- `tsconfig.base.json` with all required strict flags
- `vitest.config.ts` with correct include patterns
- `eslint.config.mjs` with flat config and `@typescript-eslint`
- `.prettierrc.json`, `.editorconfig`, `.nvmrc` all correct
- `.github/workflows/ci.yml` with correct CI steps
- All 4 packages (`shared`, `domain`, `application`, `infrastructure`) with smoke tests
- `apps/api` with smoke test
- `apps/web` placeholder with no-op typecheck
- `pnpm-lock.yaml` committed

---

## Verdict

**The implementation is functionally correct** — all acceptance criteria for M1-01 are met: the monorepo bootstraps correctly, all commands pass, CI is wired up.

**However, 5 files totaling 1,420 lines were committed outside the defined scope.** These should be removed before merging. The issue explicitly states "No app/domain code committed (this issue should not change files outside the listed scope)." The definition of done reinforces this.

**Recommendation:** Remove `design.md`, `implementation-log.md`, `issue-comments.md`, `issue.json`, and `plan.md` from the branch, then the PR is ready.