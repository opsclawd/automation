# M8-03: plan-design & plan-write Phase Handlers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the two simplest agent phases as TypeScript handlers — `plan-design` (must produce `design.md`) and `plan-write` (must produce `plan.md`) — via a shared single-shot agent helper that renders a prompt, invokes `AgentPort`, validates the agent contract, and deterministically extracts the result. This proves the handler → `AgentPort` → contract → result-extraction pipeline end-to-end in TS.

**Architecture:** A reusable `runSingleShotAgentPhase(ctx, opts)` helper (in `packages/application/src/phases/run-single-shot-agent-phase.ts`) composes the **existing** helpers `renderPrompt`, `validateAgentContract`, and `extractResult`. `PlanDesignHandler` and `PlanWriteHandler` are thin wrappers that supply their phase name, prompt step, and `AgentContract` (from the M8-01 registry). All agent calls go through `AgentPort.invoke` — handlers never name `opencode`/`pi`.

**Tech Stack:** TypeScript (strict, ESM), Vitest, `@ai-sdlc/domain`, existing application helpers.

---

## Critical context (read first)

- **Reuse, don't reinvent.** These exist and must be composed:
  - `renderPrompt(template, { runId, vars, artifacts })` — `packages/application/src/prompts/render-prompt.ts`. Supports `{{var:x}}` and `{{artifact:path}}`.
  - `loadPromptTemplate(phase, step, { promptsRoot })` → reads `<promptsRoot>/<phase>/<step>.md`.
  - `validateAgentContract({ contract, invocation, ports, cwd, expectedBranch?, repoFullName? })` → `ContractViolationCode[]` — `packages/application/src/agent/validate-agent-contract.ts`.
  - `extractResult({ invocation, ports: { artifacts, agent }, rerunContext? })` → `{ ok: true, result } | { ok: false, reason, detail, violationCode }` — `packages/application/src/results/extract-result.ts`. Handles the single retry-safe rerun automatically (plan-design/plan-write are `retrySafe: true` in `results/phase-registry.ts`).
- `AgentPort.invoke(request)` returns `AgentInvocationResult { runtime, provider, model, exitCode, durationMs, stdoutPath, stderrPath, resultJsonPath?, contractViolations, outcome, endCommitSha?, ... }`. Request shape: `AgentInvocationRequest` in `packages/application/src/ports/agent-invocation-types.ts` (requires `profile`, `promptPath`, `expectedArtifacts`, `cwd`, `runId`, `repoId`, `phaseId`, `startCommitSha`).
- **AgentInvocation domain record** (`packages/domain/src/agent-invocation.ts`) is what `validateAgentContract`/`extractResult` consume. Build it from the request + result.
- **Integration point to verify:** profile resolution. The composition root (`apps/api/src/compose.ts`) resolves a phase → `AgentProfileName` (look for `resolveProfileForPhase` / `phaseProfiles` wiring). The handler must accept the resolved `profile` from its context, **not** parse config. If an `AgentInvocation` builder/mapper already exists near the router or `agent-invocation-repository`, reuse it instead of the inline construction below.
- The `PhaseHandlerContext` is defined in M8-02 (`packages/application/src/phases/handler.ts`). Extend it here with the fields this helper needs (see Task 1).

## File structure

- Modify: `packages/application/src/phases/handler.ts` — add `promptsRoot`, `resolveProfile`, `startCommitSha`, `expectedBranch` to context.
- Create: `packages/application/src/phases/run-single-shot-agent-phase.ts` — the shared helper.
- Create: `packages/application/src/phases/handlers/plan-design.ts`
- Create: `packages/application/src/phases/handlers/plan-write.ts`
- Create: `packages/application/src/phases/__tests__/run-single-shot-agent-phase.test.ts`
- Create: `packages/application/src/phases/handlers/__tests__/plan-handlers.test.ts`
- Modify: `packages/application/src/phases/index.ts`

---

### Task 1: Extend the handler context

**Files:**
- Modify: `packages/application/src/phases/handler.ts`

- [ ] **Step 1: Add fields to `PhaseHandlerContext`** (extend the interface from M8-02):

```ts
  // added in M8-03
  promptsRoot: string;
  startCommitSha: string;
  expectedBranch: string;
  /** Resolves a phase to its configured AgentProfile name (from compose root). */
  resolveProfile: (phase: string) => string;
  idFactory: () => string;
```

- [ ] **Step 2: Typecheck.**

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/application/src/phases/handler.ts
git commit -m "feat(application): extend PhaseHandlerContext for agent phases"
```

---

### Task 2: `runSingleShotAgentPhase` helper — happy path

**Files:**
- Create: `packages/application/src/phases/run-single-shot-agent-phase.ts`
- Test: `packages/application/src/phases/__tests__/run-single-shot-agent-phase.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { runSingleShotAgentPhase } from '../run-single-shot-agent-phase.js';
import { FakeArtifactStore } from '../../test-doubles/fake-artifact-store.js';
import { FakeAgentPort } from '../../test-doubles/fake-agent-port.js';
import { FakeGitPort } from '../../test-doubles/fake-git-port.js';
import type { PhaseHandlerContext } from '../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

async function ctxWith(opts: { artifacts: FakeArtifactStore; agent: FakeAgentPort; git: FakeGitPort }) {
  // seed prompt template on disk-less render: we pass an explicit template instead of loadPromptTemplate
  const events: OrchestratorEvent[] = [];
  const ctx = {
    runId: 'r1', runUuid: 'u1', repoFullName: 'a/b', issueNumber: 1, cwd: '/wt',
    artifacts: opts.artifacts, agent: opts.agent, git: opts.git, github: {} as never,
    events: { publish: (_u: string, e: OrchestratorEvent) => events.push(e), subscribe: () => () => {} },
    now: () => new Date('2026-06-16T00:00:00Z'),
    promptsRoot: '/prompts', startCommitSha: 'sha0', expectedBranch: 'feat/x',
    resolveProfile: () => 'opencode-frontier', idFactory: () => 'inv-1',
  } as unknown as PhaseHandlerContext;
  return { ctx, events };
}

describe('runSingleShotAgentPhase', () => {
  it('renders prompt, invokes agent, validates contract, extracts result → passed', async () => {
    const artifacts = new FakeArtifactStore();
    await artifacts.write({ runId: 'u1', relativePath: 'issue.md', contents: 'do thing' });
    // design.md + result.json are "written by the agent" — simulate by pre-seeding what invoke produces
    const agent = new FakeAgentPort({
      'opencode-frontier': [
        (_req) => {
          // simulate the agent producing artifacts
          void artifacts.write({ runId: 'u1', relativePath: 'design.md', contents: '# Design' });
          void artifacts.write({ runId: 'u1', relativePath: 'result.json', contents: JSON.stringify({ status: 'complete' }) });
          return {
            runtime: 'opencode', provider: 'anthropic', model: 'claude-opus-4.7',
            exitCode: 0, durationMs: 10, stdoutPath: 's.out', stderrPath: 's.err',
            resultJsonPath: 'result.json', contractViolations: [], outcome: 'success',
            endCommitSha: 'sha0',
          };
        },
      ],
    });
    const git = new FakeGitPort();
    git.branch = 'feat/x'; git.head = 'sha0'; // see FakeGitPort fields
    const { ctx } = await ctxWith({ artifacts, agent, git });

    const res = await runSingleShotAgentPhase(ctx, {
      phase: 'plan-design',
      promptStep: 'plan-design',
      template: 'Design for {{artifact:issue.md}}',
      contract: { requiredArtifacts: ['design.md'], mustNotChangeBranch: true },
      expectedArtifacts: ['design.md', 'result.json'],
    });

    expect(res.outcome).toBe('passed');
    expect(agent.invocations[0]!.profile).toBe('opencode-frontier');
  });
});
```

> Check `FakeGitPort` (`packages/application/src/test-doubles/fake-git-port.ts`) for its exact field/method names for setting current branch and HEAD; adjust `git.branch`/`git.head` to match (e.g. it may use `currentBranch()`/`headCommitSha()` backed by settable fields).

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm exec vitest run packages/application/src/phases/__tests__/run-single-shot-agent-phase.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `run-single-shot-agent-phase.ts`:**

```ts
import type { AgentInvocation, PhaseName, AgentContract, AgentProfileName } from '@ai-sdlc/domain';
import type { PhaseHandlerContext, PhaseResult } from './handler.js';
import { renderPrompt } from '../prompts/render-prompt.js';
import { validateAgentContract } from '../agent/validate-agent-contract.js';
import { extractResult } from '../results/extract-result.js';

export interface SingleShotOpts {
  phase: string;
  promptStep: string;
  /** Pre-loaded template string (caller uses loadPromptTemplate to obtain it). */
  template: string;
  contract: AgentContract;
  expectedArtifacts: string[];
  repoId?: string;
}

export async function runSingleShotAgentPhase(
  ctx: PhaseHandlerContext,
  opts: SingleShotOpts,
): Promise<PhaseResult> {
  emit(ctx, opts.phase, 'phase.started', 'info', `${opts.phase} started`);

  const promptText = await renderPrompt(opts.template, {
    runId: ctx.runUuid,
    vars: { issueNumber: String(ctx.issueNumber) },
    artifacts: ctx.artifacts,
  });
  const promptPath = `${opts.phase}/prompt.md`;
  await ctx.artifacts.write({
    runId: ctx.runUuid,
    phaseId: opts.phase,
    relativePath: promptPath,
    contents: promptText,
  });

  const profile = ctx.resolveProfile(opts.phase) as AgentProfileName;
  const startedAt = ctx.now();
  const result = await ctx.agent.invoke({
    profile,
    promptPath,
    expectedArtifacts: opts.expectedArtifacts,
    cwd: ctx.cwd,
    runId: ctx.runUuid,
    repoId: opts.repoId ?? ctx.repoFullName,
    phaseId: opts.phase,
    startCommitSha: ctx.startCommitSha,
  });

  // Build the domain AgentInvocation record consumed by validator + extractor.
  // NOTE: if a builder already exists near the router/agent-invocation-repository, prefer it.
  const invocation: AgentInvocation = {
    id: ctx.idFactory() as AgentInvocation['id'],
    runId: ctx.runUuid as AgentInvocation['runId'],
    phaseId: opts.phase as PhaseName,
    profile,
    runtime: result.runtime,
    provider: result.provider,
    model: result.model,
    promptPath,
    promptChars: promptText.length,
    stdoutPath: result.stdoutPath,
    stderrPath: result.stderrPath,
    startedAt,
    endedAt: ctx.now(),
    startCommitSha: ctx.startCommitSha,
    ...(result.endCommitSha ? { endCommitSha: result.endCommitSha } : {}),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    timeoutMs: 0,
    outcome: result.outcome,
    contractViolations: result.contractViolations,
    ...(result.resultJsonPath ? { resultJsonPath: result.resultJsonPath } : {}),
  };

  if (result.outcome === 'timeout') {
    return fail(ctx, opts.phase, 'timeout', `${opts.phase} agent timed out`);
  }

  const violations = await validateAgentContract({
    contract: opts.contract,
    invocation,
    ports: { artifacts: ctx.artifacts, git: ctx.git, github: ctx.github },
    cwd: ctx.cwd,
    expectedBranch: opts.contract.mustNotChangeBranch ? ctx.expectedBranch : undefined,
    repoFullName: ctx.repoFullName,
  });
  if (violations.length > 0) {
    const kind = violations.includes('BRANCH_CHANGED') ? 'branch_changed' : 'agent_contract_violation';
    return fail(ctx, opts.phase, kind, `contract violations: ${violations.join(', ')}`, violations);
  }

  const extracted = await extractResult({
    invocation,
    ports: { artifacts: ctx.artifacts, agent: ctx.agent },
    rerunContext: { cwd: ctx.cwd, repoId: opts.repoId ?? ctx.repoFullName },
  });
  if (!extracted.ok) {
    const kind = extracted.reason === 'missing' ? 'missing_artifact' : 'invalid_result';
    return fail(ctx, opts.phase, kind, `${opts.phase} result ${extracted.reason}: ${extracted.detail}`);
  }

  emit(ctx, opts.phase, 'phase.completed', 'info', `${opts.phase} complete`);
  return { outcome: 'passed' };
}

function emit(
  ctx: PhaseHandlerContext, phase: string, type: string,
  level: 'info' | 'warn' | 'error', message: string, metadata: Record<string, unknown> = {},
): void {
  ctx.events.publish(ctx.runUuid, {
    runId: ctx.runUuid, phase, level, type, message,
    timestamp: ctx.now().toISOString(), metadata,
  });
}

function fail(
  ctx: PhaseHandlerContext, phase: string,
  kind: import('@ai-sdlc/domain').FailureKind, message: string, violations: string[] = [],
): PhaseResult {
  emit(ctx, phase, 'phase.failed', 'error', message, { violations });
  return {
    outcome: 'failed',
    failure: {
      runUuid: ctx.runUuid, phase, kind, message,
      canRetry: kind !== 'branch_changed',
      suggestedAction: 'Inspect the agent stdout/stderr and result.json for this phase.',
      artifacts: [], detectedAt: ctx.now(),
    },
  };
}
```

- [ ] **Step 4: Run to verify pass.**

Run: `pnpm exec vitest run packages/application/src/phases/__tests__/run-single-shot-agent-phase.test.ts`
Expected: PASS. (If `FakeGitPort` field names differ, fix the test seeding, not the helper.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(application): runSingleShotAgentPhase helper composing contract+extract"
```

---

### Task 3: Failure path — missing required artifact

**Files:**
- Test: `packages/application/src/phases/__tests__/run-single-shot-agent-phase.test.ts`

- [ ] **Step 1: Add failing test:**

```ts
it('returns agent_contract_violation when the required artifact is missing', async () => {
  const artifacts = new FakeArtifactStore();
  await artifacts.write({ runId: 'u1', relativePath: 'issue.md', contents: 'x' });
  const agent = new FakeAgentPort({
    'opencode-frontier': [
      // agent "succeeds" but writes NO design.md
      {
        runtime: 'opencode', provider: 'anthropic', model: 'm', exitCode: 0, durationMs: 1,
        stdoutPath: 's', stderrPath: 'e', resultJsonPath: undefined, contractViolations: [],
        outcome: 'success', endCommitSha: 'sha0',
      },
    ],
  });
  const git = new FakeGitPort(); git.branch = 'feat/x'; git.head = 'sha0';
  const { ctx } = await ctxWith({ artifacts, agent, git });

  const res = await runSingleShotAgentPhase(ctx, {
    phase: 'plan-design', promptStep: 'plan-design', template: 'x',
    contract: { requiredArtifacts: ['design.md'], mustNotChangeBranch: true },
    expectedArtifacts: ['design.md'],
  });

  expect(res.outcome).toBe('failed');
  expect(res.failure?.kind).toBe('agent_contract_violation');
});
```

- [ ] **Step 2–4:** Run (`pnpm exec vitest run packages/application/src/phases/__tests__/run-single-shot-agent-phase.test.ts`) — it should already PASS given the helper logic (the contract validator detects the missing artifact). If it fails, the helper's violation handling needs fixing, not the test.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test(application): single-shot phase missing-artifact failure"
```

---

### Task 4: `PlanDesignHandler` and `PlanWriteHandler`

**Files:**
- Create: `packages/application/src/phases/handlers/plan-design.ts`, `plan-write.ts`
- Test: `packages/application/src/phases/handlers/__tests__/plan-handlers.test.ts`

- [ ] **Step 1: Write the failing test** asserting each handler delegates to the helper with the right phase/contract:

```ts
import { describe, it, expect } from 'vitest';
import { PlanDesignHandler } from '../plan-design.js';
import { PlanWriteHandler } from '../plan-write.js';

describe('plan handlers', () => {
  it('PlanDesignHandler targets plan-design / design.md', () => {
    expect(new PlanDesignHandler().phase).toBe('plan-design');
  });
  it('PlanWriteHandler targets plan-write / plan.md', () => {
    expect(new PlanWriteHandler().phase).toBe('plan-write');
  });
});
```

- [ ] **Step 2: Run to verify failure.** `pnpm exec vitest run packages/application/src/phases/handlers/__tests__/plan-handlers.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement `plan-design.ts`:**

```ts
import type { PhaseName } from '@ai-sdlc/domain';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import { getPhaseDefinition } from '../phase-definitions.js';
import { runSingleShotAgentPhase } from '../run-single-shot-agent-phase.js';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';

export class PlanDesignHandler implements PhaseHandler {
  readonly phase = 'plan-design' as PhaseName;
  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const def = getPhaseDefinition(this.phase);
    const template = loadPromptTemplate('plan-design', 'plan-design', { promptsRoot: ctx.promptsRoot });
    return runSingleShotAgentPhase(ctx, {
      phase: 'plan-design',
      promptStep: 'plan-design',
      template,
      contract: def.agentContract!,
      expectedArtifacts: [...def.outputs, 'result.json'],
    });
  }
}
```

`plan-write.ts` (identical shape, different names):

```ts
import type { PhaseName } from '@ai-sdlc/domain';
import { loadPromptTemplate } from '../../prompts/load-prompt-template.js';
import { getPhaseDefinition } from '../phase-definitions.js';
import { runSingleShotAgentPhase } from '../run-single-shot-agent-phase.js';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';

export class PlanWriteHandler implements PhaseHandler {
  readonly phase = 'plan-write' as PhaseName;
  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const def = getPhaseDefinition(this.phase);
    const template = loadPromptTemplate('plan-write', 'plan-write', { promptsRoot: ctx.promptsRoot });
    return runSingleShotAgentPhase(ctx, {
      phase: 'plan-write',
      promptStep: 'plan-write',
      template,
      contract: def.agentContract!,
      expectedArtifacts: [...def.outputs, 'result.json'],
    });
  }
}
```

> Verify a prompt template exists at `prompts/plan-design/plan-design.md` and `prompts/plan-write/plan-write.md`. If the repo's prompt directory uses different names, align the `loadPromptTemplate` args (grep the `prompts/` directory).

- [ ] **Step 4: Run to verify pass.** `pnpm exec vitest run packages/application/src/phases/handlers/__tests__/plan-handlers.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(application): plan-design and plan-write phase handlers"
```

---

### Task 5: Export + boundaries + full suite

- [ ] **Step 1:** Append to `packages/application/src/phases/index.ts`:

```ts
export * from './run-single-shot-agent-phase.js';
export * from './handlers/plan-design.js';
export * from './handlers/plan-write.js';
```

- [ ] **Step 2:** Run: `pnpm -r typecheck && pnpm lint && pnpm depcruise && pnpm test` → all PASS.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(application): export plan handlers + single-shot helper"
```

---

## Self-review checklist

- [ ] Acceptance → tests: plan-design happy (Task 2) & plan-write parity (Task 4), missing-artifact failure (Task 3), no concrete runtime imported (grep for `opencode`/`pi`/`child_process` in new files → none), branch-change failure (contract `mustNotChangeBranch` exercised via the helper; add an explicit branch-mismatch test if time permits).
- [ ] Reuses `renderPrompt`, `validateAgentContract`, `extractResult` — no reimplementation.
- [ ] Profile comes from `ctx.resolveProfile`, not config parsing.
- [ ] Integration note about the AgentInvocation builder + prompt template names is present.
- [ ] Names consistent: `runSingleShotAgentPhase`, `PlanDesignHandler`, `PlanWriteHandler`, `SingleShotOpts`.

## Definition of done

Merged with green CI; both handlers run purely through ports; the shared single-shot helper is covered by happy + failure tests; profile resolution and AgentInvocation construction reconciled with the composition root.
