# Fix Step 7 Review Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the three P1/P2 findings from the spec review and fix pre-existing dependency-cruiser errors.

**Architecture:** 
1. Correct the metadata format in `apps/api/src/compose.ts` for whole-PR review and arbiter.
2. Convert fingerprint generation in `packages/application/src/review-fix/review-fix-loop.ts` (`computeNewState`) and `apps/api/src/compose.ts` (`runWholePrArbiter`) to be async and call `fingerprintFinding`.
3. Add a test to `packages/application/src/review-fix/__tests__/review-fix-integration-mode.test.ts` to assert that the prompt includes the instructed guideline.
4. Allowlist `poll-task-runner.ts` in `.dependency-cruiser.cjs` to fix pre-existing errors.

**Tech Stack:** Vitest, TypeScript, dependency-cruiser.

## Global Constraints
- Do NOT run npm/pnpm/yarn/bun build, test, lint, typecheck, depcruise, or test:bash inside agent invocation. (We will run them at the end on the terminal to verify).
- Follow inward-only dependency boundaries.

---

### Task 1: Fix Dependency-Cruiser Configuration

**Files:**
- Modify: `.dependency-cruiser.cjs`

- [ ] **Step 1: Edit .dependency-cruiser.cjs to add poll-task-runner.ts to exceptions**
- [ ] **Step 2: Verify depcruise warning count drops or errors disappear**
  Run: `pnpm depcruise`
  Expected: 0 errors (only warnings)

### Task 2: Rename 'reviewMode' to 'review_mode' and update arbiter metadata

**Files:**
- Modify: `apps/api/src/compose.ts`

- [ ] **Step 1: Rename `reviewMode` in whole-PR review metadata and arbiter metadata, and add the missing snapshot/dimension/scope fields to arbiter metadata**

### Task 3: Use fingerprintFinding SHA-256 helper

**Files:**
- Modify: `packages/application/src/review-fix/review-fix-loop.ts`
- Modify: `apps/api/src/compose.ts`

- [ ] **Step 1: Make `computeNewState` in `packages/application/src/review-fix/review-fix-loop.ts` async and use `fingerprintFinding`**
- [ ] **Step 2: Update the caller of `computeNewState` in `review-fix-loop.ts` to await it**
- [ ] **Step 3: Update `runWholePrArbiter` in `apps/api/src/compose.ts` to await `fingerprintFinding`**

### Task 4: Add coverage test case for prompt instructions

**Files:**
- Modify: `packages/application/src/review-fix/__tests__/review-fix-integration-mode.test.ts`

- [ ] **Step 1: Add a test case asserting the prompt is correctly instructed**
- [ ] **Step 2: Run vitest to ensure all tests pass**
  Run: `pnpm test packages/application/src/review-fix/__tests__/review-fix-integration-mode.test.ts`
  Expected: PASS
