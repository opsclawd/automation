# M6-01 — PR Review Domain + Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the pure domain model and SQLite persistence for managed PR-review polling: review comments with a per-comment state machine, posted replies, and poll attempts.

**Architecture:** Pure domain types + transition functions in `packages/domain` (no I/O). SQLite migration `0006` adds three tables (`pr_review_comments`, `pr_review_replies`, `poll_attempts`). Repository ports declared in `packages/application`, implemented by SQLite adapters in `packages/infrastructure`, mirroring the existing M5 validation slice. **No `jobs`/`job_attempts` queue tables** — per the M6 scope decision the poller is in-process (M6-04) and persists poll state on these focused tables; the full SQLite `JobQueuePort`/`WorkerLeasePort` adapters remain M8 work. PR-review polling reuses the same `Run` (Q17) as the `post-pr-review` phase — no new `Run` type.

**Tech Stack:** TypeScript 5 strict, Vitest, better-sqlite3.

**Prior art to mirror:**
- Domain type + pass rule: `packages/domain/src/validation.ts`
- Migration shape: `packages/infrastructure/src/sqlite/migrations/0005-validation-results.ts`
- Migration registry: `packages/infrastructure/src/sqlite/migrations.ts`
- SQLite adapter + row mapping: `packages/infrastructure/src/sqlite/validation-run-repository.ts`
- Adapter test: `packages/infrastructure/src/sqlite/__tests__/validation-run-repository.test.ts`
- Per-comment state semantics to port: `scripts/lib/comment-state.sh` (states `pending → replied → processed`, plus `blocked` after 2 unresolved attempts; two-tier verification commit/reply/build).

---

### Task 1: Domain types and comment state machine

**Files:**
- Create: `packages/domain/src/pr-review.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/__tests__/pr-review.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/domain/src/__tests__/pr-review.test.ts
import { describe, it, expect } from 'vitest';
import { RunId } from '../ids.js';
import {
  createPrReviewComment,
  markReplied,
  markProcessed,
  resetForRetry,
  blockComment,
  type PrReviewComment,
} from '../pr-review.js';

const base = () =>
  createPrReviewComment({
    runId: RunId('11111111-1111-1111-1111-111111111111'),
    prNumber: 42,
    commentId: 9001,
    path: 'src/a.ts',
    line: 10,
    reviewer: 'octocat',
    body: 'please fix',
    now: new Date('2026-06-04T00:00:00Z'),
  });

describe('PrReviewComment state machine', () => {
  it('starts pending with zero attempts', () => {
    const c = base();
    expect(c.state).toBe('pending');
    expect(c.attempts).toBe(0);
    expect(c.commitVerified).toBe(false);
    expect(c.replyVerified).toBe(false);
    expect(c.buildVerified).toBe(false);
  });

  it('pending -> replied records reply id and increments attempts', () => {
    const c = markReplied(base(), { replyId: 555, outcome: 'fixed', commitSha: 'abc123', poll: 1 });
    expect(c.state).toBe('replied');
    expect(c.replyId).toBe(555);
    expect(c.outcome).toBe('fixed');
    expect(c.commitSha).toBe('abc123');
    expect(c.attempts).toBe(1);
  });

  it('replied -> processed only when all verifications pass', () => {
    const replied = markReplied(base(), { replyId: 555, outcome: 'fixed', commitSha: 'abc', poll: 1 });
    const processed = markProcessed(replied, { commitVerified: true, replyVerified: true, buildVerified: true });
    expect(processed.state).toBe('processed');
  });

  it('markProcessed throws if a verification is missing', () => {
    const replied = markReplied(base(), { replyId: 555, outcome: 'fixed', commitSha: 'abc', poll: 1 });
    expect(() =>
      markProcessed(replied, { commitVerified: true, replyVerified: false, buildVerified: true }),
    ).toThrow(/cannot mark.*processed/i);
  });

  it('resetForRetry sends replied back to pending (verification failed)', () => {
    const replied = markReplied(base(), { replyId: 555, outcome: 'fixed', commitSha: 'abc', poll: 1 });
    const retried = resetForRetry(replied, { poll: 2 });
    expect(retried.state).toBe('pending');
    expect(retried.attempts).toBe(1); // attempts preserved
  });

  it('blockComment after 2 unresolved attempts', () => {
    let c: PrReviewComment = markReplied(base(), { replyId: 1, outcome: 'fixed', commitSha: 'a', poll: 1 });
    c = resetForRetry(c, { poll: 2 });
    c = markReplied(c, { replyId: 2, outcome: 'fixed', commitSha: 'b', poll: 2 });
    const blocked = blockComment(c, 'verification failed twice');
    expect(blocked.state).toBe('blocked');
    expect(blocked.blockedReason).toBe('verification failed twice');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ai-sdlc/domain test -- pr-review`
Expected: FAIL — `Cannot find module '../pr-review.js'`.

- [ ] **Step 3: Write the domain module**

```typescript
// packages/domain/src/pr-review.ts
import type { RunId } from './ids.js';

export type CommentState = 'pending' | 'replied' | 'processed' | 'blocked';
export type CommentOutcome = 'fixed' | 'no_fix';

/**
 * Persisted orchestration state for one GitHub PR review comment.
 * Distinct from the raw `GitHubReviewComment` returned by GitHubPort:
 * that is the wire shape; this is what the orchestrator tracks across polls.
 * Ports the state machine in scripts/lib/comment-state.sh.
 */
export interface PrReviewComment {
  runId: RunId;
  prNumber: number;
  /** GitHub REST comment databaseId — unique within (runId, prNumber). */
  commentId: number;
  path: string;
  line: number;
  reviewer: string;
  body: string;
  state: CommentState;
  attempts: number;
  outcome?: CommentOutcome;
  replyId?: number;
  commitSha?: string;
  commitVerified: boolean;
  replyVerified: boolean;
  buildVerified: boolean;
  blockedReason?: string;
  lastPoll: number;
  createdAt: Date;
  updatedAt: Date;
}

export class CommentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommentStateError';
  }
}

export interface CreatePrReviewCommentInput {
  runId: RunId;
  prNumber: number;
  commentId: number;
  path: string;
  line: number;
  reviewer: string;
  body: string;
  now: Date;
}

export function createPrReviewComment(input: CreatePrReviewCommentInput): PrReviewComment {
  return {
    runId: input.runId,
    prNumber: input.prNumber,
    commentId: input.commentId,
    path: input.path,
    line: input.line,
    reviewer: input.reviewer,
    body: input.body,
    state: 'pending',
    attempts: 0,
    commitVerified: false,
    replyVerified: false,
    buildVerified: false,
    lastPoll: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function markReplied(
  c: PrReviewComment,
  input: { replyId: number; outcome: CommentOutcome; commitSha?: string; poll: number },
): PrReviewComment {
  return {
    ...c,
    state: 'replied',
    replyId: input.replyId,
    outcome: input.outcome,
    ...(input.commitSha ? { commitSha: input.commitSha } : {}),
    attempts: c.attempts + 1,
    lastPoll: input.poll,
    updatedAt: new Date(),
  };
}

export function markProcessed(
  c: PrReviewComment,
  v: { commitVerified: boolean; replyVerified: boolean; buildVerified: boolean },
): PrReviewComment {
  if (!v.commitVerified || !v.replyVerified || !v.buildVerified) {
    throw new CommentStateError(
      `cannot mark comment ${c.commentId} processed: verification incomplete ` +
        `(commit=${v.commitVerified} reply=${v.replyVerified} build=${v.buildVerified})`,
    );
  }
  return {
    ...c,
    state: 'processed',
    commitVerified: true,
    replyVerified: true,
    buildVerified: true,
    updatedAt: new Date(),
  };
}

export function resetForRetry(c: PrReviewComment, input: { poll: number }): PrReviewComment {
  return { ...c, state: 'pending', lastPoll: input.poll, updatedAt: new Date() };
}

export function blockComment(c: PrReviewComment, reason: string): PrReviewComment {
  return { ...c, state: 'blocked', blockedReason: reason, updatedAt: new Date() };
}

/** A comment is unresolved if the agent still needs to act on it this poll. */
export function isUnresolved(c: PrReviewComment): boolean {
  return c.state === 'pending';
}
```

- [ ] **Step 4: Add the PollAttempt and PrReviewReply types in the same file**

Append to `packages/domain/src/pr-review.ts`:

```typescript
export type PollStatus = 'running' | 'completed' | 'failed' | 'rate_limited';
export type PollTerminalState = 'all_resolved' | 'max_polls_reached' | 'blocked' | undefined;

export interface PollAttempt {
  id: string;
  runId: RunId;
  prNumber: number;
  pollNumber: number;
  status: PollStatus;
  commentsFetched: number;
  commentsProcessed: number;
  startedAt: Date;
  completedAt?: Date;
  nextPollAt?: Date;
  terminalState?: 'all_resolved' | 'max_polls_reached' | 'blocked';
}

export interface PrReviewReply {
  id: string;
  runId: RunId;
  prNumber: number;
  commentId: number;
  body: string;
  postedAt: Date;
  verified: boolean;
}
```

- [ ] **Step 5: Export from the domain barrel**

In `packages/domain/src/index.ts`, add alongside the other `export *` lines:

```typescript
export * from './pr-review.js';
```

- [ ] **Step 6: Run tests + typecheck to verify pass**

Run: `pnpm --filter @ai-sdlc/domain test -- pr-review && pnpm --filter @ai-sdlc/domain typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/pr-review.ts packages/domain/src/index.ts packages/domain/src/__tests__/pr-review.test.ts
git commit -m "feat(domain): PR review comment state machine, poll attempt, and reply types (M6-01)"
```

---

### Task 2: SQLite migration 0006

**Files:**
- Create: `packages/infrastructure/src/sqlite/migrations/0006-pr-review.ts`
- Modify: `packages/infrastructure/src/sqlite/migrations.ts`
- Test: `packages/infrastructure/src/sqlite/__tests__/migrations-0006.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/infrastructure/src/sqlite/__tests__/migrations-0006.test.ts
import { describe, it, expect } from 'vitest';
import { openDatabase, applyMigrations } from '../../index.js';

describe('migration 0006 pr-review', () => {
  it('creates pr_review_comments, pr_review_replies, poll_attempts', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toContain('pr_review_comments');
    expect(tables).toContain('pr_review_replies');
    expect(tables).toContain('poll_attempts');
  });

  it('is idempotent', () => {
    const db = openDatabase(':memory:');
    applyMigrations(db);
    expect(() => applyMigrations(db)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/infrastructure test -- migrations-0006`
Expected: FAIL — tables not found.

- [ ] **Step 3: Write the migration**

```typescript
// packages/infrastructure/src/sqlite/migrations/0006-pr-review.ts
export const version = 6;

export const sql = /* sql */ `
CREATE TABLE IF NOT EXISTS pr_review_comments (
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  outcome TEXT,
  reply_id INTEGER,
  commit_sha TEXT,
  commit_verified INTEGER NOT NULL DEFAULT 0,
  reply_verified INTEGER NOT NULL DEFAULT 0,
  build_verified INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  last_poll INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_uuid, comment_id)
);

CREATE TABLE IF NOT EXISTS pr_review_replies (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  posted_at TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS poll_attempts (
  id TEXT PRIMARY KEY,
  run_uuid TEXT NOT NULL REFERENCES runs(uuid) ON DELETE CASCADE,
  pr_number INTEGER NOT NULL,
  poll_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  comments_fetched INTEGER NOT NULL DEFAULT 0,
  comments_processed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  next_poll_at TEXT,
  terminal_state TEXT
);

CREATE INDEX IF NOT EXISTS idx_pr_review_comments_run
  ON pr_review_comments (run_uuid, state);
CREATE INDEX IF NOT EXISTS idx_pr_review_replies_run
  ON pr_review_replies (run_uuid, comment_id);
CREATE INDEX IF NOT EXISTS idx_poll_attempts_run
  ON poll_attempts (run_uuid, poll_number);
`;
```

- [ ] **Step 4: Register the migration**

In `packages/infrastructure/src/sqlite/migrations.ts`, add the import next to the others and append to the `MIGRATIONS` array:

```typescript
import * as prReview from './migrations/0006-pr-review.js';
// ...
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  { version: init.version, sql: init.sql },
  { version: addPid.version, sql: addPid.sql },
  { version: agentInvocations.version, sql: agentInvocations.sql },
  { version: phaseRename.version, sql: phaseRename.sql },
  { version: validationResults.version, sql: validationResults.sql },
  { version: prReview.version, sql: prReview.sql },
];
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/infrastructure test -- migrations-0006`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/infrastructure/src/sqlite/migrations/0006-pr-review.ts packages/infrastructure/src/sqlite/migrations.ts packages/infrastructure/src/sqlite/__tests__/migrations-0006.test.ts
git commit -m "feat(infra): migration 0006 — pr_review_comments, pr_review_replies, poll_attempts (M6-01)"
```

---

### Task 3: Repository ports

**Files:**
- Create: `packages/application/src/ports/pr-review-repository-port.ts`
- Modify: `packages/application/src/ports/index.ts`
- Test: covered indirectly by Task 4 + Task 5 (interfaces only).

- [ ] **Step 1: Write the port interfaces**

```typescript
// packages/application/src/ports/pr-review-repository-port.ts
import type { RunId, PrReviewComment, PrReviewReply, PollAttempt } from '@ai-sdlc/domain';

export interface PrReviewRepositoryPort {
  upsertComment(comment: PrReviewComment): void;
  getComment(runId: RunId, commentId: number): PrReviewComment | undefined;
  listComments(runId: RunId): PrReviewComment[];
  insertReply(reply: PrReviewReply): void;
  listReplies(runId: RunId): PrReviewReply[];
  insertPollAttempt(attempt: PollAttempt): void;
  updatePollAttempt(attempt: PollAttempt): void;
  listPollAttempts(runId: RunId): PollAttempt[];
  latestPollAttempt(runId: RunId): PollAttempt | undefined;
}
```

- [ ] **Step 2: Export from the ports barrel**

In `packages/application/src/ports/index.ts`, add:

```typescript
export type { PrReviewRepositoryPort } from './pr-review-repository-port.js';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @ai-sdlc/application typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/application/src/ports/pr-review-repository-port.ts packages/application/src/ports/index.ts
git commit -m "feat(application): PrReviewRepositoryPort (M6-01)"
```

---

### Task 4: In-memory fake for the port

**Files:**
- Create: `packages/application/src/test-doubles/fake-pr-review-repository.ts`
- Modify: `packages/application/src/test-doubles/index.ts`
- Test: `packages/application/src/__tests__/fake-pr-review-repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/application/src/__tests__/fake-pr-review-repository.test.ts
import { describe, it, expect } from 'vitest';
import { RunId, createPrReviewComment, markReplied } from '@ai-sdlc/domain';
import { FakePrReviewRepository } from '../test-doubles/fake-pr-review-repository.js';

const runId = RunId('22222222-2222-2222-2222-222222222222');

describe('FakePrReviewRepository', () => {
  it('upserts and reads back a comment by id', () => {
    const repo = new FakePrReviewRepository();
    const c = createPrReviewComment({
      runId, prNumber: 7, commentId: 100, path: 'a.ts', line: 1,
      reviewer: 'r', body: 'b', now: new Date(),
    });
    repo.upsertComment(c);
    expect(repo.getComment(runId, 100)?.state).toBe('pending');
    repo.upsertComment(markReplied(c, { replyId: 9, outcome: 'fixed', poll: 1 }));
    expect(repo.getComment(runId, 100)?.state).toBe('replied');
    expect(repo.listComments(runId)).toHaveLength(1);
  });

  it('tracks the latest poll attempt', () => {
    const repo = new FakePrReviewRepository();
    repo.insertPollAttempt({
      id: 'p1', runId, prNumber: 7, pollNumber: 1, status: 'running',
      commentsFetched: 0, commentsProcessed: 0, startedAt: new Date('2026-06-04T00:00:00Z'),
    });
    repo.insertPollAttempt({
      id: 'p2', runId, prNumber: 7, pollNumber: 2, status: 'running',
      commentsFetched: 0, commentsProcessed: 0, startedAt: new Date('2026-06-04T01:00:00Z'),
    });
    expect(repo.latestPollAttempt(runId)?.pollNumber).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/application test -- fake-pr-review-repository`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fake**

```typescript
// packages/application/src/test-doubles/fake-pr-review-repository.ts
import type { RunId, PrReviewComment, PrReviewReply, PollAttempt } from '@ai-sdlc/domain';
import type { PrReviewRepositoryPort } from '../ports/pr-review-repository-port.js';

export class FakePrReviewRepository implements PrReviewRepositoryPort {
  comments = new Map<string, PrReviewComment>();
  replies: PrReviewReply[] = [];
  polls: PollAttempt[] = [];

  private key(runId: RunId, commentId: number): string {
    return `${runId}:${commentId}`;
  }

  upsertComment(comment: PrReviewComment): void {
    this.comments.set(this.key(comment.runId, comment.commentId), comment);
  }
  getComment(runId: RunId, commentId: number): PrReviewComment | undefined {
    return this.comments.get(this.key(runId, commentId));
  }
  listComments(runId: RunId): PrReviewComment[] {
    return [...this.comments.values()].filter((c) => c.runId === runId);
  }
  insertReply(reply: PrReviewReply): void {
    this.replies.push(reply);
  }
  listReplies(runId: RunId): PrReviewReply[] {
    return this.replies.filter((r) => r.runId === runId);
  }
  insertPollAttempt(attempt: PollAttempt): void {
    this.polls.push(attempt);
  }
  updatePollAttempt(attempt: PollAttempt): void {
    const i = this.polls.findIndex((p) => p.id === attempt.id);
    if (i >= 0) this.polls[i] = attempt;
    else this.polls.push(attempt);
  }
  listPollAttempts(runId: RunId): PollAttempt[] {
    return this.polls.filter((p) => p.runId === runId);
  }
  latestPollAttempt(runId: RunId): PollAttempt | undefined {
    return this.listPollAttempts(runId).sort((a, b) => b.pollNumber - a.pollNumber)[0];
  }
}
```

- [ ] **Step 4: Export from the test-doubles barrel**

In `packages/application/src/test-doubles/index.ts`, add:

```typescript
export { FakePrReviewRepository } from './fake-pr-review-repository.js';
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/application test -- fake-pr-review-repository`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/application/src/test-doubles/fake-pr-review-repository.ts packages/application/src/test-doubles/index.ts packages/application/src/__tests__/fake-pr-review-repository.test.ts
git commit -m "test(application): in-memory FakePrReviewRepository (M6-01)"
```

---

### Task 5: SQLite adapter

**Files:**
- Create: `packages/infrastructure/src/sqlite/pr-review-repository.ts`
- Modify: `packages/infrastructure/src/index.ts`
- Test: `packages/infrastructure/src/sqlite/__tests__/pr-review-repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/infrastructure/src/sqlite/__tests__/pr-review-repository.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { RunId, createPrReviewComment, markReplied } from '@ai-sdlc/domain';
import { openDatabase, applyMigrations, RunRepository } from '../../index.js';
import { PrReviewRepository } from '../pr-review-repository.js';
import type { Db } from '../database.js';

const runUuid = '33333333-3333-3333-3333-333333333333';
const runId = RunId(runUuid);

function seedRun(db: Db) {
  // Minimal run row so the FK passes. Use RunRepository to match the schema.
  const repo = new RunRepository(db);
  repo.insert({
    uuid: runUuid,
    displayId: 'issue-7-20260604-000000',
    issueNumber: 7,
    type: 'issue_to_pr',
    status: 'running',
    currentPhase: 'post-pr-review',
    completedPhases: [],
    startedAt: new Date(),
  } as never); // shape per RunRepository.insert; adjust to its real signature
}

describe('PrReviewRepository', () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(':memory:');
    applyMigrations(db);
    seedRun(db);
  });

  it('round-trips a comment through state changes', () => {
    const repo = new PrReviewRepository(db);
    const c = createPrReviewComment({
      runId, prNumber: 7, commentId: 100, path: 'a.ts', line: 3,
      reviewer: 'r', body: 'fix', now: new Date('2026-06-04T00:00:00Z'),
    });
    repo.upsertComment(c);
    expect(repo.getComment(runId, 100)?.state).toBe('pending');

    repo.upsertComment(markReplied(c, { replyId: 9, outcome: 'fixed', commitSha: 'sha1', poll: 1 }));
    const back = repo.getComment(runId, 100)!;
    expect(back.state).toBe('replied');
    expect(back.replyId).toBe(9);
    expect(back.commitSha).toBe('sha1');
    expect(back.attempts).toBe(1);
  });

  it('records and lists poll attempts', () => {
    const repo = new PrReviewRepository(db);
    repo.insertPollAttempt({
      id: 'p1', runId, prNumber: 7, pollNumber: 1, status: 'running',
      commentsFetched: 2, commentsProcessed: 0, startedAt: new Date('2026-06-04T00:00:00Z'),
    });
    repo.updatePollAttempt({
      id: 'p1', runId, prNumber: 7, pollNumber: 1, status: 'completed',
      commentsFetched: 2, commentsProcessed: 2, startedAt: new Date('2026-06-04T00:00:00Z'),
      completedAt: new Date('2026-06-04T00:05:00Z'), terminalState: 'all_resolved',
    });
    expect(repo.latestPollAttempt(runId)?.status).toBe('completed');
    expect(repo.latestPollAttempt(runId)?.terminalState).toBe('all_resolved');
  });
});
```

> **Note for the implementer:** `RunRepository.insert` may take a `Run` domain object rather than the literal above. Open `packages/infrastructure/src/sqlite/run-repository.ts`, read its `insert` signature, and construct the seed row with `createRun(...)` from `@ai-sdlc/domain` exactly as `run-repository.test.ts` does. Replace the `as never` cast accordingly.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/infrastructure test -- pr-review-repository`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the adapter** (mirror `validation-run-repository.ts` row-mapping style)

```typescript
// packages/infrastructure/src/sqlite/pr-review-repository.ts
import type { Db } from './database.js';
import {
  RunId,
  type PrReviewComment,
  type PrReviewReply,
  type PollAttempt,
  type CommentState,
  type CommentOutcome,
  type PollStatus,
} from '@ai-sdlc/domain';
import type { PrReviewRepositoryPort } from '@ai-sdlc/application/ports';

interface CommentRow {
  run_uuid: string;
  pr_number: number;
  comment_id: number;
  path: string;
  line: number;
  reviewer: string;
  body: string;
  state: string;
  attempts: number;
  outcome: string | null;
  reply_id: number | null;
  commit_sha: string | null;
  commit_verified: number;
  reply_verified: number;
  build_verified: number;
  blocked_reason: string | null;
  last_poll: number;
  created_at: string;
  updated_at: string;
}

function rowToComment(r: CommentRow): PrReviewComment {
  return {
    runId: RunId(r.run_uuid),
    prNumber: r.pr_number,
    commentId: r.comment_id,
    path: r.path,
    line: r.line,
    reviewer: r.reviewer,
    body: r.body,
    state: r.state as CommentState,
    attempts: r.attempts,
    ...(r.outcome !== null ? { outcome: r.outcome as CommentOutcome } : {}),
    ...(r.reply_id !== null ? { replyId: r.reply_id } : {}),
    ...(r.commit_sha !== null ? { commitSha: r.commit_sha } : {}),
    commitVerified: r.commit_verified === 1,
    replyVerified: r.reply_verified === 1,
    buildVerified: r.build_verified === 1,
    ...(r.blocked_reason !== null ? { blockedReason: r.blocked_reason } : {}),
    lastPoll: r.last_poll,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

interface PollRow {
  id: string;
  run_uuid: string;
  pr_number: number;
  poll_number: number;
  status: string;
  comments_fetched: number;
  comments_processed: number;
  started_at: string;
  completed_at: string | null;
  next_poll_at: string | null;
  terminal_state: string | null;
}

function rowToPoll(r: PollRow): PollAttempt {
  return {
    id: r.id,
    runId: RunId(r.run_uuid),
    prNumber: r.pr_number,
    pollNumber: r.poll_number,
    status: r.status as PollStatus,
    commentsFetched: r.comments_fetched,
    commentsProcessed: r.comments_processed,
    startedAt: new Date(r.started_at),
    ...(r.completed_at !== null ? { completedAt: new Date(r.completed_at) } : {}),
    ...(r.next_poll_at !== null ? { nextPollAt: new Date(r.next_poll_at) } : {}),
    ...(r.terminal_state !== null
      ? { terminalState: r.terminal_state as PollAttempt['terminalState'] }
      : {}),
  };
}

export class PrReviewRepository implements PrReviewRepositoryPort {
  constructor(private readonly db: Db) {}

  upsertComment(c: PrReviewComment): void {
    this.db
      .prepare(
        `INSERT INTO pr_review_comments
          (run_uuid, pr_number, comment_id, path, line, reviewer, body, state, attempts,
           outcome, reply_id, commit_sha, commit_verified, reply_verified, build_verified,
           blocked_reason, last_poll, created_at, updated_at)
         VALUES
          (@runUuid, @prNumber, @commentId, @path, @line, @reviewer, @body, @state, @attempts,
           @outcome, @replyId, @commitSha, @commitVerified, @replyVerified, @buildVerified,
           @blockedReason, @lastPoll, @createdAt, @updatedAt)
         ON CONFLICT(run_uuid, comment_id) DO UPDATE SET
           state=excluded.state, attempts=excluded.attempts, outcome=excluded.outcome,
           reply_id=excluded.reply_id, commit_sha=excluded.commit_sha,
           commit_verified=excluded.commit_verified, reply_verified=excluded.reply_verified,
           build_verified=excluded.build_verified, blocked_reason=excluded.blocked_reason,
           last_poll=excluded.last_poll, updated_at=excluded.updated_at`,
      )
      .run({
        runUuid: c.runId,
        prNumber: c.prNumber,
        commentId: c.commentId,
        path: c.path,
        line: c.line,
        reviewer: c.reviewer,
        body: c.body,
        state: c.state,
        attempts: c.attempts,
        outcome: c.outcome ?? null,
        replyId: c.replyId ?? null,
        commitSha: c.commitSha ?? null,
        commitVerified: c.commitVerified ? 1 : 0,
        replyVerified: c.replyVerified ? 1 : 0,
        buildVerified: c.buildVerified ? 1 : 0,
        blockedReason: c.blockedReason ?? null,
        lastPoll: c.lastPoll,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      });
  }

  getComment(runId: RunId, commentId: number): PrReviewComment | undefined {
    const row = this.db
      .prepare('SELECT * FROM pr_review_comments WHERE run_uuid = ? AND comment_id = ?')
      .get(runId, commentId) as CommentRow | undefined;
    return row ? rowToComment(row) : undefined;
  }

  listComments(runId: RunId): PrReviewComment[] {
    const rows = this.db
      .prepare('SELECT * FROM pr_review_comments WHERE run_uuid = ? ORDER BY comment_id')
      .all(runId) as CommentRow[];
    return rows.map(rowToComment);
  }

  insertReply(reply: PrReviewReply): void {
    this.db
      .prepare(
        `INSERT INTO pr_review_replies (id, run_uuid, pr_number, comment_id, body, posted_at, verified)
         VALUES (@id, @runUuid, @prNumber, @commentId, @body, @postedAt, @verified)`,
      )
      .run({
        id: reply.id,
        runUuid: reply.runId,
        prNumber: reply.prNumber,
        commentId: reply.commentId,
        body: reply.body,
        postedAt: reply.postedAt.toISOString(),
        verified: reply.verified ? 1 : 0,
      });
  }

  listReplies(runId: RunId): PrReviewReply[] {
    const rows = this.db
      .prepare('SELECT * FROM pr_review_replies WHERE run_uuid = ? ORDER BY posted_at')
      .all(runId) as Array<{
      id: string;
      run_uuid: string;
      pr_number: number;
      comment_id: number;
      body: string;
      posted_at: string;
      verified: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      runId: RunId(r.run_uuid),
      prNumber: r.pr_number,
      commentId: r.comment_id,
      body: r.body,
      postedAt: new Date(r.posted_at),
      verified: r.verified === 1,
    }));
  }

  insertPollAttempt(a: PollAttempt): void {
    this.db
      .prepare(
        `INSERT INTO poll_attempts
          (id, run_uuid, pr_number, poll_number, status, comments_fetched, comments_processed,
           started_at, completed_at, next_poll_at, terminal_state)
         VALUES
          (@id, @runUuid, @prNumber, @pollNumber, @status, @commentsFetched, @commentsProcessed,
           @startedAt, @completedAt, @nextPollAt, @terminalState)`,
      )
      .run(this.pollParams(a));
  }

  updatePollAttempt(a: PollAttempt): void {
    this.db
      .prepare(
        `UPDATE poll_attempts SET status=@status, comments_fetched=@commentsFetched,
           comments_processed=@commentsProcessed, completed_at=@completedAt,
           next_poll_at=@nextPollAt, terminal_state=@terminalState
         WHERE id=@id`,
      )
      .run(this.pollParams(a));
  }

  private pollParams(a: PollAttempt) {
    return {
      id: a.id,
      runUuid: a.runId,
      prNumber: a.prNumber,
      pollNumber: a.pollNumber,
      status: a.status,
      commentsFetched: a.commentsFetched,
      commentsProcessed: a.commentsProcessed,
      startedAt: a.startedAt.toISOString(),
      completedAt: a.completedAt?.toISOString() ?? null,
      nextPollAt: a.nextPollAt?.toISOString() ?? null,
      terminalState: a.terminalState ?? null,
    };
  }

  listPollAttempts(runId: RunId): PollAttempt[] {
    const rows = this.db
      .prepare('SELECT * FROM poll_attempts WHERE run_uuid = ? ORDER BY poll_number')
      .all(runId) as PollRow[];
    return rows.map(rowToPoll);
  }

  latestPollAttempt(runId: RunId): PollAttempt | undefined {
    const row = this.db
      .prepare('SELECT * FROM poll_attempts WHERE run_uuid = ? ORDER BY poll_number DESC LIMIT 1')
      .get(runId) as PollRow | undefined;
    return row ? rowToPoll(row) : undefined;
  }
}
```

- [ ] **Step 4: Export from the infrastructure barrel**

In `packages/infrastructure/src/index.ts`, add the export alongside `ValidationRunRepository`:

```typescript
export { PrReviewRepository } from './sqlite/pr-review-repository.js';
```

- [ ] **Step 5: Run to verify pass + full infra suite**

Run: `pnpm --filter @ai-sdlc/infrastructure test -- pr-review-repository && pnpm --filter @ai-sdlc/infrastructure typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/infrastructure/src/sqlite/pr-review-repository.ts packages/infrastructure/src/index.ts packages/infrastructure/src/sqlite/__tests__/pr-review-repository.test.ts
git commit -m "feat(infra): SQLite PrReviewRepository adapter (M6-01)"
```

---

### Task 6: Wire repository into the composition root

**Files:**
- Modify: `apps/api/src/compose.ts`
- Test: `apps/api/src/__tests__/compose.test.ts` (extend existing)

- [ ] **Step 1: Add an assertion to the compose test**

In `apps/api/src/__tests__/compose.test.ts`, add inside the existing describe block:

```typescript
it('exposes a prReviewRepository', () => {
  const c = composeRoot({ repoRoot: tmpRepo, scriptPath: 'scripts/ai-run-issue-v2', dbPath: ':memory:' });
  expect(c.prReviewRepository).toBeDefined();
  expect(typeof c.prReviewRepository.listComments).toBe('function');
});
```

> Match the existing `composeRoot(...)` call arguments already used in that test file; reuse its `tmpRepo` fixture variable.

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/api test -- compose`
Expected: FAIL — `prReviewRepository` undefined.

- [ ] **Step 3: Wire it in `compose.ts`**

Add `PrReviewRepository` to the infrastructure import block, instantiate it next to `validationRunRepository`, add it to the `Container` interface, and include it in the returned object:

```typescript
// in the import from '@ai-sdlc/infrastructure'
  PrReviewRepository,

// near: const validationRunRepository = new ValidationRunRepository(db);
  const prReviewRepository = new PrReviewRepository(db);

// in interface Container:
  prReviewRepository: PrReviewRepository;

// in the returned object literal:
  prReviewRepository,
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/api test -- compose && pnpm --filter @ai-sdlc/api typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/compose.ts apps/api/src/__tests__/compose.test.ts
git commit -m "feat(api): wire PrReviewRepository into composition root (M6-01)"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run the whole workspace build/lint/typecheck/test**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test`
Expected: all green.

- [ ] **Step 2: Confirm domain purity (no infra leak)**

Run: `grep -rEn "child_process|better-sqlite3|node:fs" packages/domain/src/pr-review.ts`
Expected: no matches.

---

## Self-review notes

- **Scope alignment:** Implements only M6-01 (domain + tables + repo). No GitHub adapter (M6-02), no use case (M6-03), no UI (M6-06). The `jobs`/`job_attempts` tables from the doc are intentionally omitted per the in-process-poller decision; the poll-state lives on `poll_attempts`.
- **Naming caution for downstream:** `@ai-sdlc/domain` now exports a `PrReviewComment` (persisted) while `@ai-sdlc/application/ports` still exports a `PrReviewComment` (raw GitHub shape). M6-02 renames the port type to `GitHubReviewComment` to remove the clash before M6-03 imports both. Until then they live in separate packages and do not collide.
- **Result-value mismatch (flagged for M6-03):** `packages/application/src/results/schemas/post-pr-review.ts` currently encodes `result: 'handled' | 'nothing_to_handle'`, but the shipped Bash agent contract uses `ALL_DONE | NO_FIXES_NEEDED | PARTIAL | BLOCKED`. M6-03 reconciles this; M6-01 does not touch the schema.
