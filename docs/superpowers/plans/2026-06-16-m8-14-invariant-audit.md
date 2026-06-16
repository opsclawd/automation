# M8-14: Domain Invariant Enforcement Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce an audit mapping every PRD §12 domain invariant (0a–0f, 1–12) to the code that enforces it and a test that would fail if the invariant were removed. Fill any gaps (or file follow-ups for large ones). This certifies the M8 cutover's safety net.

**Architecture:** A living doc `docs/invariant-audit.md` (invariant → enforcing code `file:line` → enforcing test) plus a consolidated test suite `packages/application/src/__tests__/invariants.test.ts` that exercises each invariant via fakes. Where an invariant is already covered by an existing test, the audit cites it; where coverage is missing, this story adds the test.

**Tech Stack:** TypeScript (strict, ESM), Vitest, all M3 fakes + the M8 executor/handlers.

---

## Critical context (read first)

- **Source of truth:** PRD §12 lists invariants 0a–0f and 1–12. Restate each verbatim in the audit doc.
- **"Would fail if removed":** the strongest form is a mutation argument. Minimally, each invariant gets a test asserting the **violating** path is rejected (e.g. starting a second active Run for the same (repo, issue) throws). Prefer reusing/【citing existing tests where they already prove the invariant.
- **Existing coverage to cite (don't duplicate):** many invariants already have tests —
  - 0b one-active-run: `packages/domain/src/__tests__/run*.test.ts`, `run-repository` insertIfNoActive.
  - 0c/0d/0e leases + concurrency: `packages/application/src/__tests__/worker-concurrency.test.ts`, `fake-worker-lease-port.test.ts`.
  - 3/4/5 contract violations: `packages/application/src/__tests__/validate-agent-contract.test.ts`, `extract-result.test.ts`.
  - 8 validation records: `run-validation.test.ts`.
  - 9 loop exhaustion → FAILED: `review-fix/__tests__/review-fix-loop.test.ts`, `domain/__tests__/loop.test.ts`.
  - 6/7 PR comment processing/replies: `pr-review` tests + `fake-pr-review-repository.test.ts`.
- This story depends on M8-10 (executor) so invariants 1, 11 (and the executor-enforced parts of 0a/0d) can be exercised end-to-end.

## File structure

- Create: `docs/invariant-audit.md`
- Create: `packages/application/src/__tests__/invariants.test.ts` (gap-filling tests + an index of cited tests)
- Possibly modify: enforcement sites for any invariant found unenforced (small fixes only).

---

### Task 1: Build the audit skeleton + classify coverage

**Files:**
- Create: `docs/invariant-audit.md`

- [ ] **Step 1:** Create the doc with a row per invariant:

```markdown
# Domain Invariant Enforcement Audit (PRD §12)

| # | Invariant (verbatim) | Enforced at (file:line) | Proven by (test) | Status |
|---|----------------------|-------------------------|------------------|--------|
| 0a | A Run may only start against an approved/registered Repository | … | … | covered / GAP |
| 0b | Only one active Run per (Repository, Issue) | … | … | … |
| … | … | … | … | … |
| 11 | Unsafe retries require explicit user confirmation | apps/api/src/routes/runs.ts (M8-12) | run-actions.test.ts | … |
| 12 | Managed PR poll job records poll count, next poll time, terminal state | … | … | … |
```

- [ ] **Step 2:** For each invariant, run a targeted grep/test search to locate the enforcement site and any existing test; fill the row. Mark `GAP` where no test would fail if the rule were removed.

```bash
# example: find the one-active-run enforcement
grep -rn "insertIfNoActive\|one active\|ActiveRun" packages | grep -v node_modules
```

- [ ] **Step 3: Commit** `git add docs/invariant-audit.md && git commit -m "docs: invariant audit skeleton with coverage classification"`

---

### Task 2: Gap-filling tests (one per GAP)

**Files:**
- Create: `packages/application/src/__tests__/invariants.test.ts`

For each invariant marked `GAP` in Task 1, add a focused test. Examples for likely gaps:

- [ ] **Step 1 (invariant 1 — cannot pass with a failed required phase):** write a `RunExecutor` test (reuse M8-10 fakes) where a required phase fails and assert the run's terminal status is NOT `passed`:

```ts
import { describe, it, expect } from 'vitest';
// reuse the makeExecutor helper / fakes from M8-10's executor tests
describe('invariant 1: no pass with a failed required phase', () => {
  it('a failed required phase yields a non-passed terminal status', async () => {
    const executor = /* makeExecutor with a failing required phase */ undefined as never;
    const result = await executor.executeRun('u');
    expect(result.status).not.toBe('passed');
  });
});
```

- [ ] **Step 2 (invariant 0a — only approved repos):** assert `RepositoryPort`/`StartIssueRun` rejects an unknown/disabled `RepositoryId` with `RepositoryNotApprovedError` (cite or add). 

- [ ] **Step 3 (invariant 2 — phase cannot complete without a structured result):** assert a phase marked `passed` always has a persisted result/`validation-result.json`/result.json (executor-level).

- [ ] **Step 4 (invariant 10 — enough artifacts to diagnose latest failure):** assert that on a phase failure, the run directory retains the prompt/stdout/stderr/failure.json (cite the run-directory + failure tests).

- [ ] **Step 5:** For invariants already covered, add an `it.todo`/comment in `invariants.test.ts` pointing to the existing test file (so the suite is a single index), and cite them in the doc — do not duplicate the assertion.

- [ ] **Step 6: Run** `pnpm exec vitest run packages/application/src/__tests__/invariants.test.ts` → PASS.

- [ ] **Step 7: Commit** `git add -A && git commit -m "test(application): gap-filling invariant tests"`

---

### Task 3: Fix small gaps; file follow-ups for large ones

- [ ] **Step 1:** For any invariant that is genuinely **unenforced** (not just untested), make the **small** fix at its natural enforcement site and add the failing→passing test. For a large fix, open a follow-up GitHub issue and link it in the audit doc's Status column (`GAP → #NNN`).

- [ ] **Step 2:** Update `docs/invariant-audit.md` so every row is `covered` or `GAP → #NNN` — no blank statuses.

- [ ] **Step 3: Commit** `git add -A && git commit -m "docs+fix: close or track every invariant gap"`

---

### Task 4: CI wiring + full sweep

- [ ] **Step 1:** Ensure the invariant suite runs under `pnpm test` (it will, via the vitest include glob). Optionally add a CI note that the audit doc must be updated when invariants change.
- [ ] **Step 2:** `pnpm -r typecheck && pnpm lint && pnpm test` → all PASS.
- [ ] **Step 3: Commit** `git add -A && git commit -m "chore: invariant audit suite in CI"`

---

## Self-review checklist

- [ ] Every PRD §12 invariant (0a–0f, 1–12) has a row in `docs/invariant-audit.md` with enforcement site + test.
- [ ] Each invariant has at least one test that would fail if the rule were removed (cited or added).
- [ ] No duplicated assertions — covered invariants cite existing tests.
- [ ] Every gap is fixed (small) or tracked with a linked follow-up issue.
- [ ] Suite runs under `pnpm test`.

## Definition of done

Merged with green CI; the audit doc is complete and cross-referenced; every invariant has an enforcing test; gaps fixed or tracked.
