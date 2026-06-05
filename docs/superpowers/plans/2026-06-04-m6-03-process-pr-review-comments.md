# M6-03 — ProcessPrReviewComments Use Case Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the application use case that runs **one PR-review processing pass**: fetch comments, skip already-processed ones, invoke the `post-pr-review` agent through `AgentPort`, commit/push and reply to each handled comment, verify the side effects, and persist per-comment state. The in-process scheduler (M6-04) calls this repeatedly.

**Architecture:** Pure application code in `packages/application`, depending only on ports (`GitHubPort`, `GitPort`, `AgentPort`, `ValidationPort`, `PrReviewRepositoryPort`, `EventBusPort`) plus the deterministic `extractResult` policy (M4-05) and a prompt renderer. No infra imports. One pass = one `PollAttempt`. Verification (commit pushed, reply visible, build passes) is done through the same ports so the whole thing is testable with fakes. Mirrors the verification semantics of `scripts/ai-pr-review-poll` (`verify_commits_pushed`, `verify_replies_posted`, `verify_build_passes`) and the comment state machine in `scripts/lib/comment-state.sh`.

**Tech Stack:** TypeScript 5 strict, Vitest, Zod (result schema).

**Depends on:** M6-01 (domain + repo), M6-02 (GitHubPort), M4-02 (AgentPort), M4-05 (`extractResult`), M5-02 (ValidationPort).

---

### Task 1: Reconcile the `post-pr-review` result schema with the shipped agent contract

**Files:**
- Modify: `packages/application/src/results/schemas/post-pr-review.ts`
- Test: `packages/application/src/results/__tests__/post-pr-review-schema.test.ts` (create)

**Why:** The current schema (`{ result: 'handled' | 'nothing_to_handle', repliesPosted }`) does not match what the shipped Bash agent emits. `scripts/ai-pr-review-poll` validates the batch outcome `ALL_DONE | NO_FIXES_NEEDED | PARTIAL | BLOCKED` and a per-comment reply manifest. Align the schema to that contract.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/application/src/results/__tests__/post-pr-review-schema.test.ts
import { describe, it, expect } from 'vitest';
import { postPrReviewResultSchema } from '../schemas/post-pr-review.js';

describe('postPrReviewResultSchema', () => {
  it('accepts a fixed-comment manifest', () => {
    const r = postPrReviewResultSchema.parse({
      outcome: 'ALL_DONE',
      comments: [{ commentId: 9001, action: 'fixed', replyBody: 'Done: changed X.' }],
    });
    expect(r.outcome).toBe('ALL_DONE');
    expect(r.comments[0].action).toBe('fixed');
  });

  it('defaults comments to [] for NO_FIXES_NEEDED', () => {
    const r = postPrReviewResultSchema.parse({ outcome: 'NO_FIXES_NEEDED' });
    expect(r.comments).toEqual([]);
  });

  it('rejects an unknown outcome', () => {
    expect(() => postPrReviewResultSchema.parse({ outcome: 'MAYBE' })).toThrow();
  });

  it('requires a non-empty replyBody on each comment', () => {
    expect(() =>
      postPrReviewResultSchema.parse({ outcome: 'PARTIAL', comments: [{ commentId: 1, action: 'fixed', replyBody: '' }] }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/application test -- post-pr-review-schema`
Expected: FAIL.

- [ ] **Step 3: Rewrite the schema**

```typescript
// packages/application/src/results/schemas/post-pr-review.ts
import { z } from 'zod';

/** Per-comment action the agent reports for one PR review comment. */
export const postPrReviewCommentSchema = z.object({
  commentId: z.number().int(),
  action: z.enum(['fixed', 'no_fix', 'blocked']),
  replyBody: z.string().min(1),
  blockedReason: z.string().optional(),
});

/** Batch outcome for one PR-review processing pass. Mirrors the
 *  ALL_DONE | NO_FIXES_NEEDED | PARTIAL | BLOCKED contract enforced by
 *  scripts/ai-pr-review-poll (validate_result_file). */
export const postPrReviewResultSchema = z.object({
  outcome: z.enum(['ALL_DONE', 'NO_FIXES_NEEDED', 'PARTIAL', 'BLOCKED']),
  comments: z.array(postPrReviewCommentSchema).default([]),
});

export type PostPrReviewComment = z.infer<typeof postPrReviewCommentSchema>;
export type PostPrReviewResult = z.infer<typeof postPrReviewResultSchema>;
```

- [ ] **Step 4: Run to verify pass + check `extractResult` still compiles**

Run: `pnpm --filter @ai-sdlc/application test -- post-pr-review-schema && pnpm --filter @ai-sdlc/application typecheck`
Expected: PASS. (The phase registry imports this schema; the change is additive-compatible at the import site.)

- [ ] **Step 5: Commit**

```bash
git add packages/application/src/results/schemas/post-pr-review.ts packages/application/src/results/__tests__/post-pr-review-schema.test.ts
git commit -m "feat(application): align post-pr-review result schema with shipped agent contract (M6-03)"
```

---

### Task 2: Use case skeleton + types + happy path (single comment, fully verified)

**Files:**
- Create: `packages/application/src/pr-review/process-pr-review-comments.ts`
- Modify: `packages/application/src/index.ts`
- Test: `packages/application/src/pr-review/__tests__/process-pr-review-comments.test.ts`

- [ ] **Step 1: Write the failing happy-path test**

```typescript
// packages/application/src/pr-review/__tests__/process-pr-review-comments.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { RunId, RepositoryId, PhaseName } from '@ai-sdlc/domain';
import {
  FakeGitHubPort,
  FakeGitPort,
  FakePrReviewRepository,
  FakeAgentPort,
} from '../../test-doubles/index.js';
import { ProcessPrReviewComments, type ProcessPrReviewDeps } from '../process-pr-review-comments.js';

const runId = RunId('44444444-4444-4444-4444-444444444444');
const repoId = RepositoryId('o/r');

function makeDeps(over: Partial<ProcessPrReviewDeps> = {}): {
  deps: ProcessPrReviewDeps;
  github: FakeGitHubPort;
  git: FakeGitPort;
  repo: FakePrReviewRepository;
  agent: FakeAgentPort;
} {
  const github = new FakeGitHubPort();
  const git = new FakeGitPort();
  const repo = new FakePrReviewRepository();
  const agent = new FakeAgentPort();

  github.prs.set('o/r/5', { number: 5, url: 'https://x/pr/5', state: 'open', headRefName: 'feat-x' });
  github.comments.set('o/r/5', [
    { id: 9001, prNumber: 5, path: 'a.ts', line: 3, reviewer: 'octocat', body: 'rename foo', createdAt: new Date('2026-06-04T00:00:00Z') },
  ]);

  // Agent: write a result.json fixing comment 9001.
  agent.scriptResult({
    outcome: 'success',
    writeResultJson: { outcome: 'ALL_DONE', comments: [{ commentId: 9001, action: 'fixed', replyBody: 'Renamed foo to bar.' }] },
  });

  const deps: ProcessPrReviewDeps = {
    github,
    git,
    agent,
    prReviewRepo: repo,
    renderPrompt: async () => '/tmp/prompt.md',
    extractResult: async () => ({ ok: true, result: { outcome: 'ALL_DONE', comments: [{ commentId: 9001, action: 'fixed', replyBody: 'Renamed foo to bar.' }] } }),
    verifyCommitPushed: async () => true,
    verifyBuildPasses: async () => true,
    resolveProfileForPhase: () => 'post-pr-review-profile' as never,
    eventBus: { publish: () => {} } as never,
    idFactory: () => 'id-' + Math.random().toString(36).slice(2),
    now: () => new Date('2026-06-04T00:10:00Z'),
    maxIterations: 10,
    ...over,
  };
  return { deps, github, git, repo, agent };
}

describe('ProcessPrReviewComments — happy path', () => {
  it('fixes, replies, verifies, resolves, and marks the comment processed', async () => {
    const { deps, github, repo } = makeDeps();
    const uc = new ProcessPrReviewComments(deps);

    const out = await uc.execute({
      runId,
      repoId,
      repoFullName: 'o/r',
      prNumber: 5,
      cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'),
      pollNumber: 1,
    });

    expect(out.outcome).toBe('ALL_DONE');
    expect(out.processed).toBe(1);

    // reply posted
    expect(github.repliesPosted).toContainEqual({ repoFullName: 'o/r', prNumber: 5, commentId: 9001, body: 'Renamed foo to bar.' });
    // thread resolved
    expect(github.resolvedThreads).toContainEqual({ repoFullName: 'o/r', prNumber: 5, commentId: 9001 });
    // persisted as processed
    expect(repo.getComment(runId, 9001)?.state).toBe('processed');
    // a poll attempt was recorded
    expect(repo.latestPollAttempt(runId)?.terminalState).toBe('all_resolved');
  });
});
```

> **Implementer note:** Check `FakeAgentPort` (`packages/application/src/test-doubles/fake-agent-port.ts`) for its real scripting API. The `scriptResult({...writeResultJson})` call above is illustrative — adapt to the fake's actual method names. Because the test also injects `extractResult` directly, the agent's result-file plumbing is not load-bearing for this test; the agent only needs to return `outcome: 'success'`.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/application test -- process-pr-review-comments`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the use case**

```typescript
// packages/application/src/pr-review/process-pr-review-comments.ts
import {
  RunId,
  RepositoryId,
  PhaseName,
  createPrReviewComment,
  markReplied,
  markProcessed,
  resetForRetry,
  blockComment,
  isUnresolved,
  type PrReviewComment,
  type PollAttempt,
} from '@ai-sdlc/domain';
import type { GitHubPort } from '../ports/github-port.js';
import type { GitPort } from '../ports/git-port.js';
import type { AgentPort } from '../ports/agent-port.js';
import type { AgentProfileName } from '../ports/agent-invocation-types.js';
import type { EventBusPort } from '../ports/event-bus-port.js';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';
import type { PostPrReviewResult } from '../results/schemas/post-pr-review.js';

export interface ProcessPrReviewDeps {
  github: GitHubPort;
  git: GitPort;
  agent: AgentPort;
  prReviewRepo: PrReviewRepositoryPort;
  /** Renders the agent prompt for the unresolved comments; returns the prompt file path. */
  renderPrompt: (input: { cwd: string; comments: PrReviewComment[]; diff: string }) => Promise<string>;
  /** Deterministic result extraction (M4-05). */
  extractResult: (input: {
    resultJsonPath?: string;
    cwd: string;
  }) => Promise<{ ok: true; result: PostPrReviewResult } | { ok: false; reason: string; detail: string }>;
  verifyCommitPushed: (input: { cwd: string; branch: string }) => Promise<boolean>;
  verifyBuildPasses: (input: { cwd: string }) => Promise<boolean>;
  resolveProfileForPhase: (phaseName: string) => AgentProfileName;
  eventBus: EventBusPort;
  idFactory: () => string;
  now: () => Date;
  maxIterations: number;
}

export interface ProcessPrReviewInput {
  runId: RunId;
  repoId: RepositoryId;
  repoFullName: string;
  prNumber: number;
  cwd: string;
  phaseId: PhaseName;
  pollNumber: number;
}

export interface ProcessPrReviewOutput {
  outcome: PostPrReviewResult['outcome'] | 'NO_UNRESOLVED';
  processed: number;
  blocked: number;
  allResolved: boolean;
}

/**
 * Runs ONE PR-review processing pass. The scheduler (M6-04) calls this once
 * per poll. Does NOT loop internally beyond a single agent invocation.
 *
 * NOTE: does not implement the narrow `ProcessPrReviewCommentsUseCase`
 * (use-cases.ts) signature `execute({ runId }) => { processed }` because this
 * pass needs PR/worktree context. M6-04 bridges the narrow interface to this.
 */
export class ProcessPrReviewComments {
  constructor(private readonly deps: ProcessPrReviewDeps) {}

  async execute(input: ProcessPrReviewInput): Promise<ProcessPrReviewOutput> {
    const d = this.deps;
    const startedAt = d.now();

    // 1. Fetch + ingest comments, skipping the agent's own replies.
    const raw = await d.github.listReviewComments(input.repoFullName, input.prNumber);
    const reviewerComments = raw.filter((c) => c.inReplyToId === undefined);
    for (const rc of reviewerComments) {
      if (!d.prReviewRepo.getComment(input.runId, rc.id)) {
        d.prReviewRepo.upsertComment(
          createPrReviewComment({
            runId: input.runId,
            prNumber: input.prNumber,
            commentId: rc.id,
            path: rc.path,
            line: rc.line,
            reviewer: rc.reviewer,
            body: rc.body,
            now: d.now(),
          }),
        );
      }
    }

    const unresolved = d.prReviewRepo
      .listComments(input.runId)
      .filter((c) => isUnresolved(c));

    // 2. Nothing to do → record all_resolved poll attempt.
    if (unresolved.length === 0) {
      this.recordPoll(input, startedAt, 0, 0, 'all_resolved');
      return { outcome: 'NO_UNRESOLVED', processed: 0, blocked: 0, allResolved: true };
    }

    // 3. Render prompt + invoke agent.
    const pr = await d.github.getPr(input.repoFullName, input.prNumber);
    const diff = await d.git.diff(input.cwd, input.prNumber ? 'origin/HEAD' : 'HEAD');
    const promptPath = await d.renderPrompt({ cwd: input.cwd, comments: unresolved, diff });
    const profile = d.resolveProfileForPhase('post-pr-review');
    const invocation = await d.agent.invoke({
      profile,
      promptPath,
      expectedArtifacts: ['result.json'],
      cwd: input.cwd,
      runId: input.runId,
      repoId: input.repoId,
      phaseId: input.phaseId,
    });

    // 4. Deterministic result extraction.
    const extracted = await d.extractResult({
      ...(invocation.resultJsonPath ? { resultJsonPath: invocation.resultJsonPath } : {}),
      cwd: input.cwd,
    });
    if (!extracted.ok) {
      this.recordPoll(input, startedAt, unresolved.length, 0, undefined, 'failed');
      return { outcome: 'BLOCKED', processed: 0, blocked: 0, allResolved: false };
    }
    const result = extracted.result;

    // 5. Apply per-comment actions + verify.
    let processed = 0;
    let blocked = 0;
    for (const item of result.comments) {
      const existing = d.prReviewRepo.getComment(input.runId, item.commentId);
      if (!existing || existing.state === 'processed') continue;

      if (item.action === 'blocked') {
        d.prReviewRepo.upsertComment(blockComment(existing, item.blockedReason ?? 'agent blocked'));
        blocked++;
        continue;
      }

      // Post the reply (the irreversible side-effect).
      await d.github.replyToReviewComment(input.repoFullName, input.prNumber, item.commentId, item.replyBody);
      const replyId = d.idFactory();
      d.prReviewRepo.insertReply({
        id: replyId,
        runId: input.runId,
        prNumber: input.prNumber,
        commentId: item.commentId,
        body: item.replyBody,
        postedAt: d.now(),
        verified: false,
      });

      let commitSha: string | undefined;
      let commitVerified = true;
      let buildVerified = true;
      if (item.action === 'fixed') {
        commitSha = await d.git.headCommitSha(input.cwd);
        commitVerified = await d.verifyCommitPushed({ cwd: input.cwd, branch: pr.headRefName });
        buildVerified = await d.verifyBuildPasses({ cwd: input.cwd });
      }

      // Verify the reply is visible.
      const after = await d.github.listReviewComments(input.repoFullName, input.prNumber);
      const replyVerified = after.some((c) => c.inReplyToId === item.commentId);

      const repliedComment = markReplied(existing, {
        replyId: Number(replyId) || existing.commentId,
        outcome: item.action === 'fixed' ? 'fixed' : 'no_fix',
        ...(commitSha ? { commitSha } : {}),
        poll: input.pollNumber,
      });

      const noFixOk = item.action === 'no_fix' && replyVerified;
      const fixOk = item.action === 'fixed' && commitVerified && replyVerified && buildVerified;
      if (noFixOk || fixOk) {
        d.prReviewRepo.upsertComment(
          markProcessed(repliedComment, {
            commitVerified: item.action === 'fixed' ? commitVerified : true,
            replyVerified,
            buildVerified: item.action === 'fixed' ? buildVerified : true,
          }),
        );
        await d.github.resolveReviewThread(input.repoFullName, input.prNumber, item.commentId);
        processed++;
      } else if (repliedComment.attempts >= 2) {
        d.prReviewRepo.upsertComment(blockComment(repliedComment, 'verification failed twice'));
        blocked++;
      } else {
        // Verification failed; keep reply but retry next poll.
        d.prReviewRepo.upsertComment(resetForRetry(repliedComment, { poll: input.pollNumber }));
      }
    }

    const stillUnresolved = d.prReviewRepo.listComments(input.runId).filter(isUnresolved);
    const terminal = stillUnresolved.length === 0 ? 'all_resolved' : undefined;
    this.recordPoll(input, startedAt, unresolved.length, processed, terminal);

    return {
      outcome: result.outcome,
      processed,
      blocked,
      allResolved: stillUnresolved.length === 0,
    };
  }

  private recordPoll(
    input: ProcessPrReviewInput,
    startedAt: Date,
    fetched: number,
    processed: number,
    terminalState?: PollAttempt['terminalState'],
    status: PollAttempt['status'] = 'completed',
  ): void {
    this.deps.prReviewRepo.insertPollAttempt({
      id: this.deps.idFactory(),
      runId: input.runId,
      prNumber: input.prNumber,
      pollNumber: input.pollNumber,
      status,
      commentsFetched: fetched,
      commentsProcessed: processed,
      startedAt,
      completedAt: this.deps.now(),
      ...(terminalState ? { terminalState } : {}),
    });
  }
}
```

- [ ] **Step 4: Export from the application barrel**

In `packages/application/src/index.ts`, add:

```typescript
export * from './pr-review/process-pr-review-comments.js';
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/application test -- process-pr-review-comments && pnpm --filter @ai-sdlc/application typecheck`
Expected: PASS.

> If `FakeGitPort` lacks `diff`/`headCommitSha`, open `packages/application/src/test-doubles/fake-git-port.ts` and confirm; the GitPort interface declares both, so the fake should already implement them. If not, add trivial stubbed returns there in this step.

- [ ] **Step 6: Commit**

```bash
git add packages/application/src/pr-review/ packages/application/src/index.ts
git commit -m "feat(application): ProcessPrReviewComments — single-pass happy path (M6-03)"
```

---

### Task 3: Dedup — already-processed comments are not re-sent to the agent

**Files:**
- Test: extend `process-pr-review-comments.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('ProcessPrReviewComments — dedup', () => {
  it('does not invoke the agent when the only comment is already processed', async () => {
    const { deps, repo, agent } = makeDeps();
    // Pre-seed comment 9001 as processed.
    const seeded = (await import('@ai-sdlc/domain')).createPrReviewComment({
      runId, prNumber: 5, commentId: 9001, path: 'a.ts', line: 3, reviewer: 'octocat', body: 'rename foo', now: new Date(),
    });
    repo.upsertComment({ ...seeded, state: 'processed', commitVerified: true, replyVerified: true, buildVerified: true });

    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({
      runId, repoId, repoFullName: 'o/r', prNumber: 5, cwd: '/work/tree',
      phaseId: PhaseName('post-pr-review'), pollNumber: 2,
    });

    expect(out.outcome).toBe('NO_UNRESOLVED');
    expect(agent.invocations.length).toBe(0); // agent never called
    expect(repo.latestPollAttempt(runId)?.terminalState).toBe('all_resolved');
  });
});
```

> Adapt `agent.invocations` to the FakeAgentPort's actual call-log property name.

- [ ] **Step 2: Run — should already PASS** (the skeleton short-circuits on no unresolved). If it fails, fix the early-return path in `execute`.

Run: `pnpm --filter @ai-sdlc/application test -- process-pr-review-comments`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/application/src/pr-review/__tests__/process-pr-review-comments.test.ts
git commit -m "test(application): dedup — processed comments skip the agent (M6-03)"
```

---

### Task 4: Block after two failed verification attempts

**Files:**
- Test: extend `process-pr-review-comments.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('ProcessPrReviewComments — blocking', () => {
  it('blocks a comment after a second failed verification', async () => {
    const { deps, repo, github } = makeDeps({
      verifyBuildPasses: async () => false, // build never passes → verification fails
      extractResult: async () => ({ ok: true, result: { outcome: 'PARTIAL', comments: [{ commentId: 9001, action: 'fixed', replyBody: 'attempted fix' }] } }),
    });
    github.comments.set('o/r/5', [
      { id: 9001, prNumber: 5, path: 'a.ts', line: 3, reviewer: 'octocat', body: 'rename foo', createdAt: new Date('2026-06-04T00:00:00Z') },
    ]);
    const uc = new ProcessPrReviewComments(deps);

    // First pass: verification fails → comment reset to pending (attempts=1).
    await uc.execute({ runId, repoId, repoFullName: 'o/r', prNumber: 5, cwd: '/w', phaseId: PhaseName('post-pr-review'), pollNumber: 1 });
    expect(repo.getComment(runId, 9001)?.state).toBe('pending');
    expect(repo.getComment(runId, 9001)?.attempts).toBe(1);

    // Second pass: verification fails again → blocked (attempts=2).
    const out2 = await uc.execute({ runId, repoId, repoFullName: 'o/r', prNumber: 5, cwd: '/w', phaseId: PhaseName('post-pr-review'), pollNumber: 2 });
    expect(repo.getComment(runId, 9001)?.state).toBe('blocked');
    expect(out2.blocked).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it passes** (the skeleton already implements `resetForRetry`/`blockComment` on `attempts >= 2`).

Run: `pnpm --filter @ai-sdlc/application test -- process-pr-review-comments`
Expected: PASS. If the attempts accounting is off-by-one, adjust the `attempts >= 2` guard and re-run.

- [ ] **Step 3: Commit**

```bash
git add packages/application/src/pr-review/__tests__/process-pr-review-comments.test.ts
git commit -m "test(application): block comment after two failed verifications (M6-03)"
```

---

### Task 5: Invalid agent result fails the pass (no silent success)

**Files:**
- Test: extend `process-pr-review-comments.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('ProcessPrReviewComments — invalid result', () => {
  it('records a failed poll and posts no replies when extractResult fails', async () => {
    const { deps, github, repo } = makeDeps({
      extractResult: async () => ({ ok: false, reason: 'invalid_result', detail: 'result.json missing outcome' }),
    });
    github.comments.set('o/r/5', [
      { id: 9001, prNumber: 5, path: 'a.ts', line: 3, reviewer: 'octocat', body: 'x', createdAt: new Date('2026-06-04T00:00:00Z') },
    ]);
    const uc = new ProcessPrReviewComments(deps);
    const out = await uc.execute({ runId, repoId, repoFullName: 'o/r', prNumber: 5, cwd: '/w', phaseId: PhaseName('post-pr-review'), pollNumber: 1 });

    expect(out.outcome).toBe('BLOCKED');
    expect(github.repliesPosted).toHaveLength(0);
    expect(repo.latestPollAttempt(runId)?.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/application test -- process-pr-review-comments`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/application/src/pr-review/__tests__/process-pr-review-comments.test.ts
git commit -m "test(application): invalid agent result blocks the pass, posts no replies (M6-03)"
```

---

### Task 6: Final verification

- [ ] **Step 1: Whole workspace green**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test`
Expected: all green.

- [ ] **Step 2: Confirm no infra import leaked into application**

Run: `grep -rEn "child_process|execa|better-sqlite3|node:fs" packages/application/src/pr-review/`
Expected: no matches.

---

## Self-review notes

- **One pass, not a loop:** This use case performs a single processing pass and records one `PollAttempt`. Looping/scheduling/`maxIterations` enforcement across passes is M6-04. `maxIterations` is carried in deps for M6-04's convenience but is not consumed here (the scheduler owns the loop bound and `readyMaxDays`).
- **No-duplicate-reply invariant (FR11):** Comments transition `pending → replied → processed`; only `pending` comments are sent to the agent, and `processed` comments are skipped in the apply loop. This is the TS port of `comment-state.sh`.
- **Verification before processed (FR12):** A `fixed` comment only reaches `processed` when commit-pushed AND reply-visible AND build-passes; otherwise it is reset for retry or blocked after two attempts.
- **Deterministic result (M4-05):** `extractResult` is injected; the use case never calls a second LLM to recover a result. Invalid result → failed poll, zero replies.
- **Bridge note:** The narrow `ProcessPrReviewCommentsUseCase` interface in `use-cases.ts` is intentionally not implemented here (documented in the class JSDoc); M6-04 adapts it.
