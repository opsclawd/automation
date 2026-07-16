# Issue #636 Operational Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the primary repository documentation accurately describe the implemented TypeScript, centralized multi-repository orchestrator and its current operational limits.

**Architecture:** Treat `README.md` as the product overview and `docs/quickstart.md` as the executable operator guide. Keep `docs/prd.md` and `docs/milestone-stories.md` as historical records with archive banners, and change source code only to correct stale CLI help text that contradicts the current TypeScript default.

**Tech Stack:** Markdown, TypeScript, Commander, Vitest, pnpm workspace tooling.

---

### Task 1: Capture the implemented documentation contract

**Files:**
- Inspect: `CONTEXT.md`
- Inspect: `apps/api/src/cli.ts`
- Inspect: `packages/domain/src/run.ts`
- Inspect: `apps/api/src/compose.ts`
- Inspect: `packages/shared/src/config/schema.ts`
- Inspect: `docs/operations/scheduler-recovery.md`
- Inspect: `docs/adr/0008-single-tenant-vps-worker-and-agent-runtime-architecture.md`
- Inspect: `docs/adr/0009-typescript-executor-cutover.md`

- [ ] **Step 1: Capture current CLI help**

Run `pnpm --filter @ai-sdlc/api dev --help`, then repeat for `run --help`, `runs --help`, and `worker --help`. Expected: all commands exit successfully and expose the implemented command names and flags.

- [ ] **Step 2: Record canonical states, phases, storage, and recovery boundaries**

Use only identifiers and behavior present in the listed source files. Preserve lowercase persisted run statuses from `packages/domain/src/run.ts`, distinguish core pipeline phases from nested review/fix phases, and retain the single-host recovery boundary.

- [ ] **Step 3: Identify stale current-behavior claims**

Run:

```bash
rg -n "M3.*next|M4\+.*planned|Planned architecture|Planned lifecycle|Planned MVP|wrapping the legacy Bash|Bash scripts currently|single-target|future work" README.md docs/quickstart.md docs/product-direction.md apps/api/src/cli.ts
```

Expected: matches form the bounded rewrite list. Historical PRD/milestone matches are handled by archive banners rather than body rewrites.

### Task 2: Rewrite the current product overview

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace roadmap-era sections with current-system sections**

Rewrite status, architecture, lifecycle, and future-direction material around: what the orchestrator does; operating model; implemented architecture; canonical issue-to-PR pipeline; deployment and concurrency boundaries; operations links; repository layout; and explicit non-goals.

- [ ] **Step 2: Describe current multi-repository execution accurately**

State that registered repositories share a centralized API/dashboard and fair scheduler, jobs remain repository-scoped, one lease serializes work per repository, global concurrency is process-local, and supported workers share one host and SQLite topology.

- [ ] **Step 3: Check README links and stale language**

Run the stale-language search from Task 1 against `README.md` alone. Expected: no matches. Inspect every relative Markdown link and verify its target exists.

- [ ] **Step 4: Commit the overview rewrite**

```bash
git add README.md
git commit -m "docs: describe the implemented orchestrator"
```

### Task 3: Rebuild the operator quickstart

**Files:**
- Modify: `docs/quickstart.md`
- Reference: `docs/operations/scheduler-recovery.md`

- [ ] **Step 1: Write the clean-checkout local path**

Document Node 22+, pnpm 9+, authenticated `gh`, installation, configuration, API/dashboard startup, embedded versus standalone worker choice, and creation of a run in a registered repository.

- [ ] **Step 2: Add centralized multi-repository operations**

Use verified CLI/API behavior to document repository registration and selection, `--repository-id`, global and repository-specific views, repository health/disable semantics, and explicit repository targeting for run management.

- [ ] **Step 3: Document lifecycle and controls**

Cover persisted run statuses and supported `runs` operations: logs, execute, resume, cancel, and check-merge-ready. Explain confirmation requirements and remove unsupported direct SQLite repair instructions.

- [ ] **Step 4: Document configuration and storage**

Explain configuration precedence, phase profiles and fallbacks, scheduler settings, database/artifact/worktree paths, TypeScript default execution, and emergency Bash limitations. Link recovery procedures rather than duplicating them.

- [ ] **Step 5: Verify every example against help output**

Run help for the top-level CLI, `run`, every documented `runs` subcommand, and `worker start`. Expected: documented flags and subcommands appear exactly in help output.

- [ ] **Step 6: Commit the operator guide**

```bash
git add docs/quickstart.md
git commit -m "docs: refresh the operational quickstart"
```

### Task 4: Separate historical plans from living guidance

**Files:**
- Modify: `docs/prd.md`
- Modify: `docs/milestone-stories.md`
- Modify: `docs/product-direction.md`

- [ ] **Step 1: Add archive banners without rewriting history**

Insert an `IMPORTANT` Markdown callout immediately after each historical document title. State that it records the original roadmap, may describe completed work as planned, and link to `README.md`, `docs/quickstart.md`, and `CONTEXT.md` for current behavior.

- [ ] **Step 2: Refresh living product direction**

Update the last-updated date and replace completed near-term items with current priorities. Preserve the product thesis, invariants, deferred ambitions, and decision log.

- [ ] **Step 3: Verify historical/current separation**

Inspect the first 18 lines of both historical documents and the `Near-term product focus` section. Expected: historical files prominently redirect to current docs; product direction no longer calls delivered foundations the next layer.

- [ ] **Step 4: Commit supporting documentation**

```bash
git add docs/prd.md docs/milestone-stories.md docs/product-direction.md
git commit -m "docs: separate current guidance from historical plans"
```

### Task 5: Correct and protect CLI help text

**Files:**
- Modify: `apps/api/src/cli.ts`
- Modify: `apps/api/src/__tests__/cli.test.ts`

- [ ] **Step 1: Add a failing help-text regression test**

Add inside `describe('CLI run command', ...)`:

```ts
it('describes the TypeScript executor as the default run path', () => {
  const program = buildProgram();
  const runCommand = program.commands.find((command) => command.name() === 'run');
  expect(runCommand?.description()).toBe(
    'Start an issue-to-PR run with the TypeScript executor by default',
  );
});
```

- [ ] **Step 2: Verify the test fails for the stale description**

Run:

```bash
pnpm --filter @ai-sdlc/api test -- src/__tests__/cli.test.ts -t "describes the TypeScript executor as the default run path"
```

Expected: FAIL because the current description says the command wraps the legacy Bash script.

- [ ] **Step 3: Update the run command description**

Change the Commander description in `apps/api/src/cli.ts` to:

```ts
.description('Start an issue-to-PR run with the TypeScript executor by default')
```

Leave Bash-specific flags labeled as Bash-only and preserve `--executor ts` as the default.

- [ ] **Step 4: Run the focused test**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Commit the help correction**

```bash
git add apps/api/src/cli.ts apps/api/src/__tests__/cli.test.ts
git commit -m "fix: describe the default TypeScript run path"
```

### Task 6: Validate the complete documentation contract

**Files:**
- Inspect: all changed files

- [ ] **Step 1: Check formatting and whitespace**

Run Prettier in check mode for all changed Markdown files, followed by `git diff --check main...HEAD`. Expected: both pass.

- [ ] **Step 2: Run the focused CLI suite**

Run `pnpm --filter @ai-sdlc/api test -- src/__tests__/cli.test.ts`. Expected: PASS.

- [ ] **Step 3: Run all mandatory pre-PR gates**

Run separately, in order:

```bash
pnpm -r build
pnpm -r typecheck
pnpm lint
pnpm -r test
```

Expected: every command exits 0. If any fails, fix it and rerun all four from the beginning.

- [ ] **Step 4: Review acceptance criteria and final diff**

Run `git status --short`, `git diff --stat main...HEAD`, and `git diff --check main...HEAD`. Expected: only issue #636 files are changed, no unstaged work remains, and each acceptance criterion maps to a verified documentation section or test.
