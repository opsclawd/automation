# M8-01: Phase Definition Registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a declarative, pure phase-definition registry (order, inputs/outputs, agent contract, retry-safety, skippability) that the run executor (M8-10) and every phase handler (M8-02…M8-09) reads from, so phase knowledge lives in one place instead of being scattered through control flow.

**Architecture:** A new pure module `packages/application/src/phases/phase-definitions.ts` exporting a `CANONICAL_PHASE_ORDER` array, a `PHASE_DEFINITIONS` record, and pure helper functions. No I/O, no infrastructure imports. It is **separate from** the existing `packages/application/src/results/phase-registry.ts` (which only maps phase → `result.json` Zod schema); this registry covers ordering and I/O contracts. The two are complementary.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), Vitest, branded domain types from `@ai-sdlc/domain`.

---

## Critical context (read first)

- **Reality of phase names.** The shipped phase set (see `apps/web/src/lib/timeline.ts` `CANONICAL_PHASES` and migration `packages/infrastructure/src/sqlite/migrations/0004-phase-rename.ts`) is: `read_issue, plan-design, plan-write, implement, validate, fix-validate, whole-pr-review, fix-review, compound, create-pr` and the poll phase is persisted as `post-pr-review`. The milestone doc's *target* model collapses `whole-pr-review` + `fix-review` → `review-fix` and renames the poll phase `pr-review-poll`. **That collapse/rename is M8-06's job, not this one.**
- **Therefore:** This story defines the registry using the **currently shipped phase names** so it composes with `results/phase-registry.ts` and the executor without forcing the rename early. Add a `// TODO(M8-06): review-fix collapse` comment at the `whole-pr-review`/`fix-review` entries. M8-06 will merge those two entries into one `review-fix` entry atomically.
- Pure-module rule: `packages/application` must not import `fs`, `child_process`, SQLite, or `@ai-sdlc/infrastructure`. The dependency-cruiser config (`pnpm depcruise`) enforces this.
- Branded types: `PhaseName` is defined in `@ai-sdlc/domain` (`packages/domain/src/ids.ts`). Import it; do not redefine.
- Domain contract type: `AgentContract` (`packages/domain/src/agent-contract.ts`) has shape `{ requiredArtifacts?, allowedResultValues?, mustNotChangeBranch?, mustCreateCommit?, mustPush?, mustPostReplies? }`.

## File structure

- Create: `packages/application/src/phases/phase-definitions.ts` — types, data, pure helpers.
- Create: `packages/application/src/phases/index.ts` — re-exports.
- Create: `packages/application/src/phases/__tests__/phase-definitions.test.ts` — unit tests.
- Modify: `packages/application/src/index.ts` — export the new module.

Run all tests for one file with: `pnpm exec vitest run <path>`. Typecheck with `pnpm -r typecheck`. Lint with `pnpm lint`.

---

### Task 1: Define types and errors

**Files:**
- Create: `packages/application/src/phases/phase-definitions.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/application/src/phases/__tests__/phase-definitions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  CANONICAL_PHASE_ORDER,
  PHASE_DEFINITIONS,
  getPhaseDefinition,
  orderedPhases,
  nextPhase,
  assertInputsAvailable,
  UnknownPhaseError,
  InvalidSkipListError,
  MissingRequiredInputError,
} from '../phase-definitions.js';

describe('phase definitions registry', () => {
  it('exposes the shipped canonical order', () => {
    expect(CANONICAL_PHASE_ORDER).toEqual([
      'read_issue',
      'plan-design',
      'plan-write',
      'implement',
      'validate',
      'fix-validate',
      'whole-pr-review',
      'fix-review',
      'compound',
      'create-pr',
      'post-pr-review',
    ]);
  });

  it('has a definition for every phase in the order', () => {
    for (const name of CANONICAL_PHASE_ORDER) {
      expect(PHASE_DEFINITIONS[name]).toBeDefined();
      expect(PHASE_DEFINITIONS[name]!.name).toBe(name);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/application/src/phases/__tests__/phase-definitions.test.ts`
Expected: FAIL — `Cannot find module '../phase-definitions.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/application/src/phases/phase-definitions.ts`:

```ts
import type { PhaseName, AgentContract } from '@ai-sdlc/domain';

export interface PhaseDefinition {
  name: PhaseName;
  inputs: { required: string[]; optional: string[] };
  outputs: string[];
  agentContract?: AgentContract;
  retrySafety: 'safe' | 'unsafe';
  skippable: boolean;
}

export class UnknownPhaseError extends Error {
  constructor(public readonly phase: string) {
    super(`unknown phase: '${phase}'`);
    this.name = 'UnknownPhaseError';
  }
}

export class InvalidSkipListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSkipListError';
  }
}

export class MissingRequiredInputError extends Error {
  constructor(
    public readonly phase: string,
    public readonly missing: string[],
  ) {
    super(`phase '${phase}' missing required inputs: ${missing.join(', ')}`);
    this.name = 'MissingRequiredInputError';
  }
}

// Shipped phase names. TODO(M8-06): collapse 'whole-pr-review' + 'fix-review' → 'review-fix'.
export const CANONICAL_PHASE_ORDER = [
  'read_issue',
  'plan-design',
  'plan-write',
  'implement',
  'validate',
  'fix-validate',
  'whole-pr-review',
  'fix-review',
  'compound',
  'create-pr',
  'post-pr-review',
] as const satisfies readonly PhaseName[];

export const PHASE_DEFINITIONS: Record<PhaseName, PhaseDefinition> = {
  read_issue: {
    name: 'read_issue' as PhaseName,
    inputs: { required: [], optional: [] },
    outputs: ['issue.md', 'issue-comments.md'],
    retrySafety: 'safe',
    skippable: false,
  },
  'plan-design': {
    name: 'plan-design' as PhaseName,
    inputs: { required: ['issue.md'], optional: ['issue-comments.md'] },
    outputs: ['design.md'],
    agentContract: { requiredArtifacts: ['design.md'], mustNotChangeBranch: true },
    retrySafety: 'safe',
    skippable: false,
  },
  'plan-write': {
    name: 'plan-write' as PhaseName,
    inputs: { required: ['design.md'], optional: [] },
    outputs: ['plan.md'],
    agentContract: { requiredArtifacts: ['plan.md'], mustNotChangeBranch: true },
    retrySafety: 'safe',
    skippable: false,
  },
  implement: {
    name: 'implement' as PhaseName,
    inputs: { required: ['plan.md'], optional: [] },
    outputs: ['implementation-log.md'],
    retrySafety: 'safe',
    skippable: false,
  },
  validate: {
    name: 'validate' as PhaseName,
    inputs: { required: [], optional: [] },
    outputs: ['validation-result.json'],
    retrySafety: 'safe',
    skippable: false,
  },
  'fix-validate': {
    name: 'fix-validate' as PhaseName,
    inputs: { required: [], optional: ['validation-result.json'] },
    outputs: [],
    retrySafety: 'safe',
    skippable: false,
  },
  // TODO(M8-06): merge the next two entries into a single 'review-fix' entry.
  'whole-pr-review': {
    name: 'whole-pr-review' as PhaseName,
    inputs: { required: [], optional: [] },
    outputs: ['review.md'],
    agentContract: { requiredArtifacts: ['review.md'], mustNotChangeBranch: true },
    retrySafety: 'safe',
    skippable: false,
  },
  'fix-review': {
    name: 'fix-review' as PhaseName,
    inputs: { required: [], optional: ['review.md'] },
    outputs: ['review-fix-log.md'],
    retrySafety: 'safe',
    skippable: false,
  },
  compound: {
    name: 'compound' as PhaseName,
    inputs: { required: ['plan.md'], optional: ['design.md'] },
    outputs: ['compound.md'],
    agentContract: { requiredArtifacts: ['compound.md'], mustNotChangeBranch: true },
    retrySafety: 'safe',
    skippable: true,
  },
  'create-pr': {
    name: 'create-pr' as PhaseName,
    inputs: { required: ['plan.md'], optional: ['compound.md'] },
    outputs: ['pr-summary.md', 'pr-url.txt'],
    agentContract: { requiredArtifacts: ['pr-summary.md'] },
    retrySafety: 'unsafe',
    skippable: false,
  },
  'post-pr-review': {
    name: 'post-pr-review' as PhaseName,
    inputs: { required: ['pr-url.txt'], optional: [] },
    outputs: ['comments.json', 'reviews.json'],
    retrySafety: 'safe',
    skippable: false,
  },
} as Record<PhaseName, PhaseDefinition>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run packages/application/src/phases/__tests__/phase-definitions.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/application/src/phases/phase-definitions.ts packages/application/src/phases/__tests__/phase-definitions.test.ts
git commit -m "feat(application): add phase definition registry data + types"
```

---

### Task 2: `getPhaseDefinition` with typed unknown-phase error

**Files:**
- Modify: `packages/application/src/phases/phase-definitions.ts`
- Test: `packages/application/src/phases/__tests__/phase-definitions.test.ts`

- [ ] **Step 1: Add the failing test** (append inside the `describe`):

```ts
it('returns a definition by name', () => {
  expect(getPhaseDefinition('plan-design' as PhaseName).outputs).toEqual(['design.md']);
});

it('throws UnknownPhaseError for an unknown phase', () => {
  expect(() => getPhaseDefinition('bogus' as PhaseName)).toThrow(UnknownPhaseError);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm exec vitest run packages/application/src/phases/__tests__/phase-definitions.test.ts`
Expected: FAIL — `getPhaseDefinition is not a function`.

- [ ] **Step 3: Implement** (append to `phase-definitions.ts`):

```ts
export function getPhaseDefinition(name: PhaseName): PhaseDefinition {
  const def = PHASE_DEFINITIONS[name];
  if (!def) throw new UnknownPhaseError(name as unknown as string);
  return def;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm exec vitest run packages/application/src/phases/__tests__/phase-definitions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/application/src/phases/phase-definitions.ts packages/application/src/phases/__tests__/phase-definitions.test.ts
git commit -m "feat(application): getPhaseDefinition lookup with typed error"
```

---

### Task 3: `orderedPhases(skip)` with skip validation

**Files:**
- Modify: `packages/application/src/phases/phase-definitions.ts`
- Test: same test file

- [ ] **Step 1: Add failing tests:**

```ts
it('omits skippable phases from the order', () => {
  const names = orderedPhases(['compound' as PhaseName]).map((p) => p.name);
  expect(names).not.toContain('compound');
  expect(names).toContain('plan-design');
});

it('rejects skipping a non-skippable phase', () => {
  expect(() => orderedPhases(['create-pr' as PhaseName])).toThrow(InvalidSkipListError);
});

it('rejects a skip that orphans a downstream required input', () => {
  // skipping plan-write removes plan.md, which implement requires
  expect(() => orderedPhases(['plan-write' as PhaseName])).toThrow(InvalidSkipListError);
});

it('rejects an unknown phase in the skip list', () => {
  expect(() => orderedPhases(['nope' as PhaseName])).toThrow(InvalidSkipListError);
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm exec vitest run packages/application/src/phases/__tests__/phase-definitions.test.ts`
Expected: FAIL — `orderedPhases is not a function`.

- [ ] **Step 3: Implement** (append):

```ts
export function orderedPhases(skip: PhaseName[]): PhaseDefinition[] {
  const skipSet = new Set<string>(skip as unknown as string[]);

  for (const s of skipSet) {
    const def = PHASE_DEFINITIONS[s as PhaseName];
    if (!def) throw new InvalidSkipListError(`unknown phase in skip list: '${s}'`);
    if (!def.skippable) throw new InvalidSkipListError(`phase '${s}' is not skippable`);
  }

  const kept = CANONICAL_PHASE_ORDER.filter((n) => !skipSet.has(n)).map(
    (n) => PHASE_DEFINITIONS[n]!,
  );

  // Validate no kept phase requires an artifact that only a skipped phase produces.
  const producedByKept = new Set<string>();
  for (const def of kept) {
    for (const req of def.inputs.required) {
      if (!producedByKept.has(req)) {
        const producedByAnyKept = kept.some((d) => d.outputs.includes(req));
        if (!producedByAnyKept) {
          throw new InvalidSkipListError(
            `skipping orphans required input '${req}' needed by phase '${def.name}'`,
          );
        }
      }
    }
    for (const out of def.outputs) producedByKept.add(out);
  }

  return kept;
}
```

- [ ] **Step 4: Run to verify pass.**

Run: `pnpm exec vitest run packages/application/src/phases/__tests__/phase-definitions.test.ts`
Expected: PASS.

> Note: the orphan check is order-sensitive but the canonical order guarantees producers precede consumers, so the simple "any kept phase produces it" test is sufficient. Keep it simple (YAGNI).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(application): orderedPhases with skip-list validation"
```

---

### Task 4: `nextPhase` and `assertInputsAvailable`

**Files:**
- Modify: `packages/application/src/phases/phase-definitions.ts`
- Test: same test file

- [ ] **Step 1: Add failing tests:**

```ts
it('nextPhase returns the following phase, skipping skipped ones', () => {
  expect(nextPhase('plan-design' as PhaseName, [])).toBe('plan-write');
  expect(nextPhase('plan-write' as PhaseName, [])).toBe('implement');
  expect(nextPhase('post-pr-review' as PhaseName, [])).toBeNull();
});

it('assertInputsAvailable passes when required inputs are present', () => {
  expect(() =>
    assertInputsAvailable(getPhaseDefinition('plan-write' as PhaseName), ['design.md']),
  ).not.toThrow();
});

it('assertInputsAvailable throws naming missing required inputs', () => {
  expect(() =>
    assertInputsAvailable(getPhaseDefinition('plan-write' as PhaseName), ['issue.md']),
  ).toThrow(MissingRequiredInputError);
});

it('assertInputsAvailable ignores absent optional inputs', () => {
  expect(() =>
    assertInputsAvailable(getPhaseDefinition('plan-design' as PhaseName), ['issue.md']),
  ).not.toThrow();
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm exec vitest run packages/application/src/phases/__tests__/phase-definitions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** (append):

```ts
export function nextPhase(current: PhaseName, skip: PhaseName[]): PhaseName | null {
  const order = orderedPhases(skip).map((p) => p.name);
  const idx = order.indexOf(current);
  if (idx === -1 || idx === order.length - 1) return null;
  return order[idx + 1]!;
}

export function assertInputsAvailable(phase: PhaseDefinition, present: string[]): void {
  const have = new Set(present);
  const missing = phase.inputs.required.filter((r) => !have.has(r));
  if (missing.length > 0) {
    throw new MissingRequiredInputError(phase.name as unknown as string, missing);
  }
}
```

- [ ] **Step 4: Run to verify pass.**

Run: `pnpm exec vitest run packages/application/src/phases/__tests__/phase-definitions.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(application): nextPhase + assertInputsAvailable input gating"
```

---

### Task 5: Wire exports and verify boundaries

**Files:**
- Create: `packages/application/src/phases/index.ts`
- Modify: `packages/application/src/index.ts`

- [ ] **Step 1: Create `packages/application/src/phases/index.ts`:**

```ts
export * from './phase-definitions.js';
```

- [ ] **Step 2: Add to `packages/application/src/index.ts`** (append a re-export line near the other exports):

```ts
export * from './phases/index.js';
```

- [ ] **Step 3: Typecheck, lint, dependency boundaries.**

Run:
```bash
pnpm -r typecheck && pnpm lint && pnpm depcruise
```
Expected: all pass. `depcruise` must NOT report `packages/application` importing infrastructure/fs/child_process.

- [ ] **Step 4: Full test run.**

Run: `pnpm test`
Expected: PASS (no regressions).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(application): export phase definition registry"
```

---

## Self-review checklist (run before opening PR)

- [ ] Every issue acceptance criterion maps to a test: canonical order ✔ (Task 1), unknown-phase throw ✔ (Task 2), skip omits/rejects/orphan ✔ (Task 3), input gating ✔ (Task 4), no infra imports ✔ (Task 5 depcruise).
- [ ] No placeholders; every step has real code or a real command.
- [ ] Names consistent: `getPhaseDefinition`, `orderedPhases`, `nextPhase`, `assertInputsAvailable`, `PHASE_DEFINITIONS`, `CANONICAL_PHASE_ORDER` used identically across tasks.
- [ ] `TODO(M8-06)` comment present at the `whole-pr-review`/`fix-review` entries so the rename owner finds it.

## Definition of done

Merged to `main` with green CI (`pnpm test`, `pnpm lint`, `pnpm -r typecheck`, `pnpm depcruise`). Registry is pure (no infra imports). The phase-name reality note is captured in code for M8-06.
