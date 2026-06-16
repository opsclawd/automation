# M8-02: read_issue Phase Handler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `read_issue` phase as a TypeScript handler that fetches the issue via `GitHubPort`, writes `issue.md` / `issue-comments.md` artifacts, and blocks the run if the issue carries the `ai:blocked` label — replacing the issue-intake block at the top of `scripts/ai-run-issue-v2`.

**Architecture:** Introduce a shared `PhaseHandler` contract (this is the first handler; M8-10's executor consumes it). The `ReadIssueHandler` is a class taking a `deps`-style context with `github: GitHubPort`, `artifacts: ArtifactStore`, `events: EventBusPort`. Pure application layer — all I/O behind ports, unit-tested with `FakeGitHubPort` + `FakeArtifactStore`.

**Tech Stack:** TypeScript (strict, ESM), Vitest, `@ai-sdlc/domain`, existing ports in `packages/application/src/ports/`.

---

## Critical context (read first)

- **The real script's `read_issue` behavior** (`scripts/ai-run-issue-v2` ~line 1442–1466): fetch `gh issue view --json number,title,body,url,labels`; write the body to `issue.md`; fetch comments via REST and write to `issue-comments.md`; **the only hard validation is: if labels contain `ai:blocked` → fail** (`orchestrator_fail "Issue has ai:blocked label"`). There is **no required-section check** in the shipped script. Mirror this — do not invent stricter validation.
- `GitHubPort` (`packages/application/src/ports/github-port.ts`) exposes `getIssue(repoFullName, issueNumber): Promise<{ number; title; body; labels: string[] }>`. It does **not** currently expose issue comments. For this story, write `issue-comments.md` as an empty file and add `// TODO: add GitHubPort.listIssueComments` (the gh adapter fetches them in the script; a follow-up can port it). Keep scope tight.
- `ArtifactStore.write({ runId, phaseId?, relativePath, contents })` and `.read(runId, relativePath)`; missing reads throw `ArtifactNotFoundError`. See `packages/application/src/ports/artifact-store.ts`.
- `EventBusPort.publish(runUuid, event)` where `event` is an `OrchestratorEvent` from `@ai-sdlc/shared` — shape `{ runId, phase, level, type, message, timestamp, metadata }` (see how `ReviewFixLoop.emit` builds it in `packages/application/src/review-fix/review-fix-loop.ts`).
- Fakes already exist: `FakeGitHubPort`, `FakeArtifactStore` in `packages/application/src/test-doubles/`. `FakeGitHubPort.issues.set(`${repo}/${n}`, issue)` seeds an issue.

## File structure

- Create: `packages/application/src/phases/handler.ts` — shared `PhaseHandler` / `PhaseHandlerContext` / `PhaseResult` types.
- Create: `packages/application/src/phases/handlers/read-issue.ts` — the handler.
- Create: `packages/application/src/phases/handlers/__tests__/read-issue.test.ts`.
- Modify: `packages/application/src/phases/index.ts` — export handler + contract.

---

### Task 1: Define the shared `PhaseHandler` contract

**Files:**
- Create: `packages/application/src/phases/handler.ts`

- [ ] **Step 1: Write the contract** (no test yet — it's pure types consumed by Task 2's test):

```ts
import type { PhaseName, Failure } from '@ai-sdlc/domain';
import type { ArtifactStore } from '../ports/artifact-store.js';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';
import type { AgentPort } from '../ports/agent-port.js';
import type { EventBusPort } from '../ports/event-bus-port.js';

export interface PhaseHandlerContext {
  runId: string;
  runUuid: string;
  repoFullName: string;
  issueNumber: number;
  cwd: string; // worktree path
  artifacts: ArtifactStore;
  github: GitHubPort;
  git: GitPort;
  agent: AgentPort;
  events: EventBusPort;
  now: () => Date;
}

export type PhaseOutcome = 'passed' | 'failed' | 'blocked' | 'skipped';

export interface PhaseResult {
  outcome: PhaseOutcome;
  failure?: Failure;
}

export interface PhaseHandler {
  readonly phase: PhaseName;
  run(ctx: PhaseHandlerContext): Promise<PhaseResult>;
}
```

> The context carries the superset of ports any handler may need. Individual handlers use only what they require. M8-10's executor builds this context per phase.

- [ ] **Step 2: Typecheck.**

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/application/src/phases/handler.ts
git commit -m "feat(application): shared PhaseHandler contract"
```

---

### Task 2: ReadIssueHandler happy path

**Files:**
- Create: `packages/application/src/phases/handlers/read-issue.ts`
- Test: `packages/application/src/phases/handlers/__tests__/read-issue.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { ReadIssueHandler } from '../read-issue.js';
import { FakeGitHubPort } from '../../../test-doubles/fake-github-port.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

function makeCtx(github: FakeGitHubPort, artifacts: FakeArtifactStore) {
  const events: OrchestratorEvent[] = [];
  const ctx = {
    runId: 'issue-7-run',
    runUuid: 'uuid-1',
    repoFullName: 'acme/widgets',
    issueNumber: 7,
    cwd: '/tmp/wt',
    artifacts,
    github,
    git: {} as never,
    agent: {} as never,
    events: { publish: (_u: string, e: OrchestratorEvent) => events.push(e), subscribe: () => () => {} },
    now: () => new Date('2026-06-16T00:00:00Z'),
  } as unknown as PhaseHandlerContext;
  return { ctx, events };
}

describe('ReadIssueHandler', () => {
  it('writes issue.md and returns passed for a normal issue', async () => {
    const github = new FakeGitHubPort();
    github.issues.set('acme/widgets/7', {
      number: 7,
      title: 'Add a thing',
      body: 'Please add the thing.',
      labels: ['enhancement'],
    });
    const artifacts = new FakeArtifactStore();
    const { ctx, events } = makeCtx(github, artifacts);

    const result = await new ReadIssueHandler().run(ctx);

    expect(result.outcome).toBe('passed');
    expect(await artifacts.read('uuid-1', 'issue.md')).toContain('Please add the thing.');
    expect(await artifacts.read('uuid-1', 'issue-comments.md')).toBeDefined();
    expect(events.some((e) => e.type === 'artifact.created')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm exec vitest run packages/application/src/phases/handlers/__tests__/read-issue.test.ts`
Expected: FAIL — cannot find `../read-issue.js`.

- [ ] **Step 3: Implement `read-issue.ts`:**

```ts
import type { PhaseName } from '@ai-sdlc/domain';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';

export class ReadIssueHandler implements PhaseHandler {
  readonly phase = 'read_issue' as PhaseName;

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    this.emit(ctx, 'phase.started', 'info', 'reading issue');

    const issue = await ctx.github.getIssue(ctx.repoFullName, ctx.issueNumber);

    if (issue.labels.includes('ai:blocked')) {
      const failure = {
        runUuid: ctx.runUuid,
        phase: 'read_issue',
        kind: 'agent_blocked' as const,
        message: `Issue #${ctx.issueNumber} has the ai:blocked label`,
        canRetry: false,
        suggestedAction: 'Remove the ai:blocked label from the issue, then retry the run.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      this.emit(ctx, 'phase.failed', 'error', failure.message);
      return { outcome: 'blocked', failure };
    }

    const issueMd = `# ${issue.title}\n\n${issue.body}\n`;
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue.md',
      contents: issueMd,
    });
    this.emit(ctx, 'artifact.created', 'info', 'wrote issue.md', { path: 'issue.md' });

    // TODO: add GitHubPort.listIssueComments and populate this. Empty for now.
    await ctx.artifacts.write({
      runId: ctx.runUuid,
      phaseId: 'read_issue',
      relativePath: 'issue-comments.md',
      contents: '',
    });
    this.emit(ctx, 'artifact.created', 'info', 'wrote issue-comments.md', {
      path: 'issue-comments.md',
    });

    this.emit(ctx, 'phase.completed', 'info', 'read issue complete');
    return { outcome: 'passed' };
  }

  private emit(
    ctx: PhaseHandlerContext,
    type: string,
    level: 'info' | 'warn' | 'error',
    message: string,
    metadata: Record<string, unknown> = {},
  ): void {
    ctx.events.publish(ctx.runUuid, {
      runId: ctx.runUuid,
      phase: 'read_issue',
      level,
      type,
      message,
      timestamp: ctx.now().toISOString(),
      metadata,
    });
  }
}
```

- [ ] **Step 4: Run to verify pass.**

Run: `pnpm exec vitest run packages/application/src/phases/handlers/__tests__/read-issue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/application/src/phases/handlers/read-issue.ts packages/application/src/phases/handlers/__tests__/read-issue.test.ts
git commit -m "feat(application): read_issue phase handler happy path"
```

---

### Task 3: Blocked-label and GitHub-error paths

**Files:**
- Test: same test file

- [ ] **Step 1: Add failing tests:**

```ts
it('returns blocked when the issue has the ai:blocked label', async () => {
  const github = new FakeGitHubPort();
  github.issues.set('acme/widgets/7', {
    number: 7,
    title: 'Blocked one',
    body: 'body',
    labels: ['ai:blocked'],
  });
  const artifacts = new FakeArtifactStore();
  const { ctx } = makeCtx(github, artifacts);

  const result = await new ReadIssueHandler().run(ctx);

  expect(result.outcome).toBe('blocked');
  expect(result.failure?.kind).toBe('agent_blocked');
  // no issue.md written on the blocked path
  await expect(artifacts.read('uuid-1', 'issue.md')).rejects.toThrow();
});

it('surfaces a github_failed failure when getIssue throws', async () => {
  const github = new FakeGitHubPort(); // no issue seeded → getIssue throws
  const artifacts = new FakeArtifactStore();
  const { ctx } = makeCtx(github, artifacts);

  const result = await new ReadIssueHandler().run(ctx);

  expect(result.outcome).toBe('failed');
  expect(result.failure?.kind).toBe('github_failed');
});
```

- [ ] **Step 2: Run to verify failure.**

Run: `pnpm exec vitest run packages/application/src/phases/handlers/__tests__/read-issue.test.ts`
Expected: FAIL — the github-error test fails because the handler doesn't catch yet.

- [ ] **Step 3: Wrap `getIssue` in a try/catch** in `read-issue.ts` (replace the `getIssue` call):

```ts
    let issue;
    try {
      issue = await ctx.github.getIssue(ctx.repoFullName, ctx.issueNumber);
    } catch (e) {
      const failure = {
        runUuid: ctx.runUuid,
        phase: 'read_issue',
        kind: 'github_failed' as const,
        message: `Failed to fetch issue #${ctx.issueNumber}: ${(e as Error).message}`,
        canRetry: true,
        suggestedAction: 'Check gh auth and network, then retry.',
        artifacts: [],
        detectedAt: ctx.now(),
      };
      this.emit(ctx, 'phase.failed', 'error', failure.message);
      return { outcome: 'failed', failure };
    }
```

- [ ] **Step 4: Run to verify pass.**

Run: `pnpm exec vitest run packages/application/src/phases/handlers/__tests__/read-issue.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(application): read_issue blocked-label + github-error handling"
```

---

### Task 4: Export + boundary check

**Files:**
- Modify: `packages/application/src/phases/index.ts`

- [ ] **Step 1: Append exports:**

```ts
export * from './handler.js';
export * from './handlers/read-issue.js';
```

- [ ] **Step 2: Typecheck, lint, boundaries, full test.**

Run:
```bash
pnpm -r typecheck && pnpm lint && pnpm depcruise && pnpm test
```
Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(application): export read_issue handler + PhaseHandler contract"
```

---

## Self-review checklist

- [ ] Acceptance criteria → tests: writes `issue.md`+`issue-comments.md` & passed ✔ (Task 2), blocked label → blocked ✔ (Task 3), artifact.created events ✔ (Task 2), fake-only (no real gh) ✔ (all), github error → `github_failed` ✔ (Task 3).
- [ ] Faithful to the script: only the `ai:blocked` gate, no invented required-section validation.
- [ ] `TODO` for `listIssueComments` left so the comments follow-up is discoverable.
- [ ] Names consistent: `ReadIssueHandler`, `PhaseHandler`, `PhaseHandlerContext`, `PhaseResult`.

## Definition of done

Merged with green CI; handler runs only through ports; blocked-label and github-error paths covered; `PhaseHandler` contract exported for M8-10.
