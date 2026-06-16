# M8-08: create-pr Phase Handler — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `create-pr` phase handler: the agent drafts `pr-summary.md`, then the **orchestrator** opens the PR via `GitHubPort.createPullRequest`, writes `pr-url.txt`, and flips issue labels. Re-running after a PR already exists must NOT create a duplicate (the phase is `retrySafety: 'unsafe'`).

**Architecture:** A two-stage handler: (1) agent draft via `runSingleShotAgentPhase` (contract requires `pr-summary.md`); (2) deterministic GitHub side-effects via `GitHubPort`. Idempotency: detect an existing PR before creating. Labels via `GitHubPort.updateIssueLabels` mirroring the Bash script.

**Tech Stack:** TypeScript (strict, ESM), Vitest, `GitHubPort`, single-shot helper.

---

## Critical context (read first)

- **Q16:** agent **drafts** the PR description; orchestrator **creates** the PR via the API. The agent must not open the PR.
- `GitHubPort` (`packages/application/src/ports/github-port.ts`): `createPullRequest({ repoFullName, baseBranch, headBranch, title, body, draft? })` → `{ number, url, state }`; `getPr(repoFullName, prNumber)` → detail incl. `headRefName`; `updateIssueLabels(repoFullName, issueNumber, { add?, remove? })`. **There is no "find PR by branch" method.** For idempotency this story: check whether `pr-url.txt` already exists in artifacts (within-run idempotency) and add a `// TODO: GitHubPort.findOpenPrForBranch` for cross-process robustness. Keep scope tight.
- **Labels (from `scripts/ai-run-issue-v2` ~line 4648–4654):** on create-pr the script does `--remove-label ai:in-progress` then `--add-label ai:pr-ready` when validation passed (else `ai:needs-human-review`). Since `create-pr` only runs after `validate` passed in the pipeline, this handler removes `ai:in-progress` and adds `ai:pr-ready`. (The needs-human-review branch is handled by the executor when validation failed and create-pr is not reached.)
- Phase definition (M8-01): required input `plan.md`, optional `compound.md`, outputs `pr-summary.md` + `pr-url.txt`, `retrySafety: 'unsafe'`, contract `requiredArtifacts: ['pr-summary.md']`.
- Reuse `runSingleShotAgentPhase` (M8-03). Uses `FakeGitHubPort` (`createdPrInputs`, `createdPrs`, `labelChanges`) for tests.

## File structure

- Create: `packages/application/src/phases/handlers/create-pr.ts`
- Create: `packages/application/src/phases/handlers/__tests__/create-pr.test.ts`
- Modify: `packages/application/src/phases/index.ts`

---

### Task 1: Happy path — draft, open PR, write url, label

**Files:**
- Create: `packages/application/src/phases/handlers/create-pr.ts`
- Test: `packages/application/src/phases/handlers/__tests__/create-pr.test.ts`

- [ ] **Step 1: Write the failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { CreatePrHandler } from '../create-pr.js';
import { FakeArtifactStore } from '../../../test-doubles/fake-artifact-store.js';
import { FakeAgentPort } from '../../../test-doubles/fake-agent-port.js';
import { FakeGitPort } from '../../../test-doubles/fake-git-port.js';
import { FakeGitHubPort } from '../../../test-doubles/fake-github-port.js';
import type { PhaseHandlerContext } from '../../handler.js';
import type { OrchestratorEvent } from '@ai-sdlc/shared';

function build() {
  const artifacts = new FakeArtifactStore();
  const github = new FakeGitHubPort();
  const agent = new FakeAgentPort({
    'opencode-frontier': [
      () => {
        void artifacts.write({ runId: 'u1', relativePath: 'pr-summary.md', contents: '## Summary\nDoes the thing.' });
        void artifacts.write({ runId: 'u1', relativePath: 'result.json', contents: JSON.stringify({ status: 'complete' }) });
        return { runtime: 'opencode', provider: 'anthropic', model: 'm', exitCode: 0, durationMs: 1, stdoutPath: 's', stderrPath: 'e', resultJsonPath: 'result.json', contractViolations: [], outcome: 'success', endCommitSha: 'sha0' };
      },
    ],
  });
  const git = new FakeGitPort();
  const events: OrchestratorEvent[] = [];
  const ctx = {
    runId: 'u1', runUuid: 'u1', repoFullName: 'acme/widgets', issueNumber: 7, cwd: '/wt',
    artifacts, agent, git, github,
    events: { publish: (_u: string, e: OrchestratorEvent) => events.push(e), subscribe: () => () => {} },
    now: () => new Date('2026-06-16T00:00:00Z'),
    promptsRoot: '/prompts', startCommitSha: 'sha0', expectedBranch: 'feat/issue-7',
    resolveProfile: () => 'opencode-frontier', idFactory: () => 'inv-1',
  } as unknown as PhaseHandlerContext;
  return { artifacts, github, ctx };
}

describe('CreatePrHandler', () => {
  it('drafts summary, opens PR, writes pr-url.txt, flips labels', async () => {
    const { artifacts, github, ctx } = build();
    const res = await new CreatePrHandler({ baseBranch: 'main', headBranch: 'feat/issue-7', template: 'summarise {{artifact:plan.md}}' }).run(ctx);

    expect(res.outcome).toBe('passed');
    expect(github.createdPrInputs).toHaveLength(1);
    expect(github.createdPrInputs[0]!.headBranch).toBe('feat/issue-7');
    expect(await artifacts.read('u1', 'pr-url.txt')).toContain('https://example/pr/');
    expect(github.labelChanges[0]).toMatchObject({ issueNumber: 7, add: ['ai:pr-ready'], remove: ['ai:in-progress'] });
  });
});
```

> The test injects the template to avoid disk; production loads it via `loadPromptTemplate`. Pre-seed `plan.md` if your single-shot template references it (`artifacts.write({ runId:'u1', relativePath:'plan.md', ... })`).

- [ ] **Step 2: Run to verify failure.** → FAIL.

- [ ] **Step 3: Implement `create-pr.ts`:**

```ts
import type { PhaseName } from '@ai-sdlc/domain';
import { getPhaseDefinition } from '../phase-definitions.js';
import { runSingleShotAgentPhase } from '../run-single-shot-agent-phase.js';
import type { PhaseHandler, PhaseHandlerContext, PhaseResult } from '../handler.js';

export interface CreatePrHandlerOpts {
  baseBranch: string;
  headBranch: string;
  /** Optional explicit prompt template (tests inject); production uses loadPromptTemplate. */
  template?: string;
}

export class CreatePrHandler implements PhaseHandler {
  readonly phase = 'create-pr' as PhaseName;
  constructor(private readonly opts: CreatePrHandlerOpts) {}

  async run(ctx: PhaseHandlerContext): Promise<PhaseResult> {
    const def = getPhaseDefinition(this.phase);

    // Stage 1: agent drafts pr-summary.md (contract: requiredArtifacts ['pr-summary.md'])
    const draft = await runSingleShotAgentPhase(ctx, {
      phase: 'create-pr',
      promptStep: 'create-pr',
      template: this.opts.template ?? '', // production: loadPromptTemplate('create-pr','create-pr',{promptsRoot})
      contract: def.agentContract!,
      expectedArtifacts: ['pr-summary.md', 'result.json'],
    });
    if (draft.outcome !== 'passed') return draft; // contract/extract failure already classified

    const summary = await ctx.artifacts.read(ctx.runUuid, 'pr-summary.md');
    const title = firstHeadingOrLine(summary, ctx.issueNumber);

    // Stage 2: idempotency — if pr-url.txt already exists for this run, reuse it.
    let prUrl: string | undefined;
    try {
      prUrl = (await ctx.artifacts.read(ctx.runUuid, 'pr-url.txt')).trim();
    } catch {
      prUrl = undefined;
    }

    if (!prUrl) {
      try {
        // TODO: GitHubPort.findOpenPrForBranch(repoFullName, headBranch) for cross-process idempotency.
        const pr = await ctx.github.createPullRequest({
          repoFullName: ctx.repoFullName,
          baseBranch: this.opts.baseBranch,
          headBranch: this.opts.headBranch,
          title,
          body: summary,
        });
        prUrl = pr.url;
        this.emit(ctx, 'pr.created', 'info', `opened PR ${pr.number}`, { number: pr.number, url: pr.url });
      } catch (e) {
        return this.fail(ctx, 'github_failed', `failed to create PR: ${(e as Error).message}`);
      }
    } else {
      this.emit(ctx, 'pr.reused', 'info', `reusing existing PR url ${prUrl}`, { url: prUrl });
    }

    await ctx.artifacts.write({ runId: ctx.runUuid, phaseId: 'create-pr', relativePath: 'pr-url.txt', contents: prUrl + '\n' });

    try {
      await ctx.github.updateIssueLabels(ctx.repoFullName, ctx.issueNumber, {
        remove: ['ai:in-progress'],
        add: ['ai:pr-ready'],
      });
    } catch (e) {
      // Label failure is non-fatal but recorded.
      this.emit(ctx, 'github.label_update_failed', 'warn', `label update failed: ${(e as Error).message}`);
    }

    this.emit(ctx, 'phase.completed', 'info', 'create-pr complete');
    return { outcome: 'passed' };
  }

  private emit(ctx: PhaseHandlerContext, type: string, level: 'info' | 'warn' | 'error', message: string, metadata: Record<string, unknown> = {}): void {
    ctx.events.publish(ctx.runUuid, { runId: ctx.runUuid, phase: 'create-pr', level, type, message, timestamp: ctx.now().toISOString(), metadata });
  }
  private fail(ctx: PhaseHandlerContext, kind: import('@ai-sdlc/domain').FailureKind, message: string): PhaseResult {
    this.emit(ctx, 'phase.failed', 'error', message);
    return { outcome: 'failed', failure: { runUuid: ctx.runUuid, phase: 'create-pr', kind, message, canRetry: true, suggestedAction: 'Check gh auth/branch state; resume create-pr.', artifacts: ['pr-summary.md'], detectedAt: ctx.now() } };
  }
}

function firstHeadingOrLine(summary: string, issueNumber: number): string {
  const heading = summary.split('\n').find((l) => l.startsWith('#'));
  if (heading) return heading.replace(/^#+\s*/, '').trim();
  const firstLine = summary.split('\n').find((l) => l.trim().length > 0);
  return firstLine?.trim() ?? `Resolve issue #${issueNumber}`;
}
```

- [ ] **Step 4: Run to verify pass.** → PASS.

- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(application): create-pr phase handler (agent draft + GitHubPort)"`

---

### Task 2: Idempotency — existing PR is not duplicated

**Files:**
- Test: same file

- [ ] **Step 1: Add failing test:** pre-seed `pr-url.txt`, run, assert no new PR created and existing url preserved:

```ts
it('does not create a second PR when pr-url.txt already exists', async () => {
  const { artifacts, github, ctx } = build();
  await artifacts.write({ runId: 'u1', relativePath: 'pr-url.txt', contents: 'https://example/pr/existing\n' });
  const res = await new CreatePrHandler({ baseBranch: 'main', headBranch: 'feat/issue-7', template: 'x' }).run(ctx);
  expect(res.outcome).toBe('passed');
  expect(github.createdPrInputs).toHaveLength(0); // reused, not created
  expect((await artifacts.read('u1', 'pr-url.txt')).trim()).toBe('https://example/pr/existing');
});
```

- [ ] **Step 2: Run.** Should PASS given Task 1 logic (it reads pr-url.txt first). If the single-shot draft re-runs the agent and that's undesirable on reuse, add a guard to skip the draft when pr-url.txt exists — note it and add a test.

- [ ] **Step 3: Commit** `git add -A && git commit -m "test(application): create-pr idempotency guard"`

---

### Task 3: Missing summary + GitHub failure

**Files:**
- Test: same file

- [ ] **Step 1: Add tests:** (a) agent succeeds but writes no `pr-summary.md` → `agent_contract_violation`/`missing_artifact`, no PR created; (b) `github.createPullRequest` throws → `github_failed`. Use `FakeGitHubPort` subclass overriding `createPullRequest` to throw, or push a rejecting stub.

- [ ] **Step 2–4:** Implement is already in place; run to confirm the failure paths classify correctly. Adjust if needed.

- [ ] **Step 5: Commit** `git add -A && git commit -m "test(application): create-pr missing-summary + github-failure paths"`

---

### Task 4: Export + boundaries + full suite

- [ ] **Step 1:** Append `export * from './handlers/create-pr.js';` to `phases/index.ts`. In production wiring (M8-10), load the prompt via `loadPromptTemplate('create-pr','create-pr',{promptsRoot})`.
- [ ] **Step 2:** `pnpm -r typecheck && pnpm lint && pnpm depcruise && pnpm test` → all PASS.
- [ ] **Step 3: Commit** `git add -A && git commit -m "feat(application): export create-pr phase handler"`

---

## Self-review checklist

- [ ] Acceptance → tests: happy path opens PR + url + labels (Task 1), existing-PR idempotency (Task 2), missing summary + github failure (Task 3).
- [ ] Agent drafts only; orchestrator calls `createPullRequest` (Q16).
- [ ] Labels match the script (remove `ai:in-progress`, add `ai:pr-ready`).
- [ ] `TODO` for `findOpenPrForBranch` left for cross-process idempotency.
- [ ] Names consistent: `CreatePrHandler`, `CreatePrHandlerOpts`.

## Definition of done

Merged with green CI; idempotency guard proven; labels mirror the Bash script; agent never opens the PR.
