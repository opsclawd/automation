# M8-07: compound Phase Handler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `compound` phase handler — a skippable single-shot agent phase that writes `compound.md`. It is **skipped by default** (`phases.skip: ["compound"]` in the Q26 sample), so the run must proceed cleanly when it is skipped, and `create-pr` must tolerate the absent optional `compound.md` input.

**Architecture:** `CompoundHandler` reuses `runSingleShotAgentPhase` (M8-03) with the `compound` phase definition (M8-01: required input `plan.md`, optional `design.md`, output `compound.md`, profile `phaseProfiles['compound']`). Skip resolution is the executor's job (M8-10) — this handler runs only when not skipped.

**Tech Stack:** TypeScript (strict, ESM), Vitest, existing single-shot helper.

---

## Critical context (read first)

- **Q26:** default config skips `compound` (`phases.skip: ["compound"]`). The M8-01 registry marks `compound` `skippable: true`. `orderedPhases(skip)` therefore omits it by default.
- **Q32:** `compound.md` is an **optional** input to `create-pr`. When compound is skipped, `create-pr` silently omits it (its registry entry lists `compound.md` under `optional`). No missing-artifact failure may result.
- Reuse `runSingleShotAgentPhase` from M8-03 and `getPhaseDefinition('compound')` from M8-01. Profile via `ctx.resolveProfile('compound')` (default Pi/Qwen with OpenCode fallback per Q26 — fallback handled inside the agent layer/router).
- Prompt template: confirm one exists at `prompts/compound/compound.md` (grep `prompts/`). If absent, this story creates a minimal one.

## File structure

- Create: `packages/application/src/phases/handlers/compound.ts`
- Create: `packages/application/src/phases/handlers/__tests__/compound.test.ts`
- Modify: `packages/application/src/phases/index.ts`
- Possibly create: `prompts/compound/compound.md`

---

### Task 1: CompoundHandler happy path

**Files:**
- Create: `packages/application/src/phases/handlers/compound.ts`
- Test: `packages/application/src/phases/handlers/__tests__/compound.test.ts`

- [ ] **Step 1: Write the failing test** (model the agent/artifact seeding on M8-03's single-shot test):

```ts
import { describe, it, expect } from 'vitest';
import { CompoundHandler } from '../compound.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeAgentPort } from '../../../test-doubles/fake-agent-port.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

describe('CompoundHandler', () => {
  it('produces compound.md and returns passed when enabled', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({ runId: 'u1', relativePath: 'plan.md', contents: '## Task 1: x' });
    const agent = new FakeAgentPort({
      'pi-qwen-local': [
        () => {
          void artifacts.write({ runId: 'u1', relativePath: 'compound.md', contents: '# Learnings' });
          void artifacts.write({ runId: 'u1', relativePath: 'result.json', contents: JSON.stringify({ status: 'complete' }) });
          return { runtime: 'pi', provider: 'local', model: 'qwen', exitCode: 0, durationMs: 1, stdoutPath: 's', stderrPath: 'e', resultJsonPath: 'result.json', contractViolations: [], outcome: 'success', endCommitSha: 'sha0' };
        },
      ],
    });
    const git = new FakeGitPort(); // seed currentBranch/head to match expectedBranch/startCommitSha
    const events: OrchestratorEvent[] = [];
    const ctx = {
      runId: 'u1', runUuid: 'u1', repoFullName: 'a/b', issueNumber: 1, cwd: '/wt',
      artifacts, agent, git, github: {} as never,
      events: { publish: (_u: string, e: OrchestratorEvent) => events.push(e), subscribe: () => () => {} },
      now: () => new Date('2026-06-16T00:00:00Z'),
      promptsRoot: '/prompts', startCommitSha: 'sha0', expectedBranch: 'feat/x',
      resolveProfile: () => 'pi-qwen-local', idFactory: () => 'inv-1',
    } as unknown as PhaseHandlerContext;

    const res = await new CompoundHandler('# compound for {{artifact:plan.md}}').run(ctx);
    expect(res.outcome).toBe('passed');
    expect(await artifacts.read('u1', 'compound.md')).toContain('Learnings');
  });
});
```

- [ ] **Step 2: Run to verify failure.** → FAIL.

- [ ] **Step 3: Implement `compound.ts`:**

```ts
import type { PhaseName } from '@ai-sdlc/domain';
import { getPhaseDefinition } from '../phase-definitions.js';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import { runSingleShotAgentPhase } from '../run-single-shot-agent-phase.js';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';

export class CompoundHandler implements PhaseHandler {
  readonly phase = 'compound' as PhaseName;
  /** Optional explicit template (tests inject it); production loads from disk. */
  constructor(private readonly template?: string) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const def = getPhaseDefinition(this.phase);
    const template = this.template ?? loadPromptTemplate('compound', 'compound', { promptsRoot: ctx.promptsRoot });
    return runSingleShotAgentPhase(ctx, {
      phase: 'compound',
      promptStep: 'compound',
      template,
      contract: def.agentContract!,
      expectedArtifacts: [...def.outputs, 'result.json'],
    });
  }
}
```

- [ ] **Step 4: Run to verify pass.** → PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): compound phase handler"`

---

### Task 2: Skip-path regression — create-pr tolerates absent compound.md

**Files:**
- Test: `packages/application/src/phases/__tests__/compound-skip.test.ts`

This guards Q32: with `compound` skipped, `assertInputsAvailable` for `create-pr` must not fail on the missing optional `compound.md`.

- [ ] **Step 1: Write the test:**

```ts
import { describe, it, expect } from 'vitest';
import { orderedPhases, getPhaseDefinition, assertInputsAvailable } from '../phase-definitions.js';
import type { PhaseName } from '@ai-sdlc/domain';

describe('compound skip behaviour', () => {
  it('omits compound from the order when skipped', () => {
    const names = orderedPhases(['compound' as PhaseName]).map((p) => p.name);
    expect(names).not.toContain('compound');
  });
  it('create-pr input gating passes without compound.md (optional input)', () => {
    const createPr = getPhaseDefinition('create-pr' as PhaseName);
    // present artifacts: plan.md only, compound.md absent
    expect(() => assertInputsAvailable(createPr, ['plan.md'])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run.** Should PASS given M8-01's registry (compound skippable; compound.md optional for create-pr). If it fails, the registry data is wrong → fix in M8-01's file, not here.

- [ ] **Step 3: Commit** `git add -A && git commit -m "test(application): compound skip does not break create-pr input gating"`

---

### Task 3: Export + boundaries + full suite

- [ ] **Step 1:** Append `export * from './handlers/compound.js';` to `packages/application/src/phases/index.ts`.
- [ ] **Step 2:** If no `prompts/compound/compound.md` exists, create a minimal one referencing `{{artifact:plan.md}}`.
- [ ] **Step 3:** `pnpm -r typecheck && pnpm lint && pnpm depcruise && pnpm test` → all PASS.
- [ ] **Step 4: Commit** `git add -A && git commit -m "feat(application): export compound phase handler"`

---

## Self-review checklist

- [ ] Acceptance → tests: enabled → compound.md + passed (Task 1), skipped → omitted + create-pr unaffected (Task 2).
- [ ] Uses `phaseProfiles['compound']` via `ctx.resolveProfile`; fallback handled by the agent layer.
- [ ] Thin reuse of `runSingleShotAgentPhase`.
- [ ] Names consistent: `CompoundHandler`.

## Definition of done

Merged with green CI; default-skipped behaviour verified; `create-pr` unaffected by absent `compound.md`.
