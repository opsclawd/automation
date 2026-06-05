# M6-02 — GitHubPort gh-CLI Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a concrete `GhCliAdapter` that implements `GitHubPort` over the `gh` CLI, covering issue/PR reads, review-comment listing, reply posting, review-thread resolution, and label updates — with retry/backoff on transient failures and a typed `github_failed` error otherwise.

**Architecture:** A single adapter class in `packages/infrastructure/src/github/` that shells out to `gh` via `execa` (already a dependency — see `packages/infrastructure/src/agent/external-cli-runner.ts`). The exact `gh` invocations are lifted verbatim from the battle-tested Bash poller (`scripts/ai-pr-review-poll`). Tests drive the adapter against a **fake `gh` shim script** (same fixture pattern as the agent adapters in `packages/infrastructure/src/agent/__fixtures__/`). The `gh` binary path is injectable so tests point at the shim.

**Tech Stack:** TypeScript 5 strict, Vitest, execa, `gh` CLI (real one only in an opt-in integration suite).

**Prior art / exact command shapes (from `scripts/ai-pr-review-poll`):**
- Issue: `gh issue view <n> --json number,title,body,labels`
- PR: `gh pr view <n> --json number,url,state,headRefName`
- List review comments (paginated): `gh api --paginate repos/<owner>/<repo>/pulls/<pr>/comments`
- Reply: `gh api repos/<owner>/<repo>/pulls/<pr>/comments/<cid>/replies --method POST --raw-field body=<text>`
- Resolve thread: `gh api graphql` query `reviewThreads` + `resolveReviewThread` mutation (poll script lines 368–401)
- Labels: `gh issue edit <n> --add-label / --remove-label`

---

### Task 1: Extend & disambiguate the GitHubPort interface

**Files:**
- Modify: `packages/application/src/ports/github-port.ts`
- Modify: `packages/application/src/ports/index.ts`
- Modify: `packages/application/src/test-doubles/fake-github-port.ts`
- Test: `packages/application/src/__tests__/fake-github-port.test.ts` (create)

**Why:** M6-03 imports both the persisted `PrReviewComment` (domain) and the raw GitHub comment shape. Rename the port's `PrReviewComment` → `GitHubReviewComment` to avoid the clash, and add the read methods the poller needs (`getPr`, `resolveReviewThread`).

- [ ] **Step 1: Write the failing test for the extended fake**

```typescript
// packages/application/src/__tests__/fake-github-port.test.ts
import { describe, it, expect } from 'vitest';
import { FakeGitHubPort } from '../test-doubles/fake-github-port.js';

describe('FakeGitHubPort (extended for M6)', () => {
  it('returns PR metadata via getPr', async () => {
    const gh = new FakeGitHubPort();
    gh.prs.set('o/r/5', { number: 5, url: 'https://x/pr/5', state: 'open', headRefName: 'feat-x' });
    const pr = await gh.getPr('o/r', 5);
    expect(pr.headRefName).toBe('feat-x');
    expect(pr.state).toBe('open');
  });

  it('records resolved threads', async () => {
    const gh = new FakeGitHubPort();
    await gh.resolveReviewThread('o/r', 5, 9001);
    expect(gh.resolvedThreads).toContainEqual({ repoFullName: 'o/r', prNumber: 5, commentId: 9001 });
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/application test -- fake-github-port`
Expected: FAIL — `getPr`/`prs`/`resolveReviewThread` not defined.

- [ ] **Step 3: Update `github-port.ts`**

Rename the interface and add methods:

```typescript
// packages/application/src/ports/github-port.ts
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

export interface PullRequest {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
}

/** PR metadata read view used by the poller. */
export interface PullRequestDetail extends PullRequest {
  headRefName: string;
}

/** Raw GitHub review comment (wire shape). Distinct from the persisted
 *  `PrReviewComment` domain record in @ai-sdlc/domain. */
export interface GitHubReviewComment {
  id: number;
  prNumber: number;
  path: string;
  line: number;
  reviewer: string;
  body: string;
  createdAt: Date;
  /** Present when this comment is itself a reply to another comment. */
  inReplyToId?: number;
}

export interface CreatePullRequestInput {
  repoFullName: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
  draft?: boolean;
}

export interface GitHubPort {
  getIssue(repoFullName: string, issueNumber: number): Promise<GitHubIssue>;
  getPr(repoFullName: string, prNumber: number): Promise<PullRequestDetail>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequest>;
  listReviewComments(repoFullName: string, prNumber: number): Promise<GitHubReviewComment[]>;
  listPrCommentsSince(
    repoFullName: string,
    prNumber: number,
    sinceIso: string,
  ): Promise<GitHubReviewComment[]>;
  replyToReviewComment(
    repoFullName: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<void>;
  resolveReviewThread(repoFullName: string, prNumber: number, commentId: number): Promise<void>;
  updateIssueLabels(
    repoFullName: string,
    issueNumber: number,
    labels: { add?: string[]; remove?: string[] },
  ): Promise<void>;
}
```

- [ ] **Step 4: Update the ports barrel export**

In `packages/application/src/ports/index.ts`, change the `github-port` re-export to:

```typescript
export type {
  GitHubPort,
  GitHubIssue,
  PullRequest,
  PullRequestDetail,
  GitHubReviewComment,
  CreatePullRequestInput,
} from './github-port.js';
```

- [ ] **Step 5: Update the fake to match**

Rewrite `packages/application/src/test-doubles/fake-github-port.ts` so the type import uses `GitHubReviewComment`, add a `prs` map, `getPr`, `resolveReviewThread`, and a `resolvedThreads` log. Keep the existing fields/methods:

```typescript
import type {
  GitHubPort,
  GitHubIssue,
  PullRequest,
  PullRequestDetail,
  GitHubReviewComment,
  CreatePullRequestInput,
} from '../ports/github-port.js';

export class FakeGitHubPort implements GitHubPort {
  issues = new Map<string, GitHubIssue>();
  prs = new Map<string, PullRequestDetail>();
  comments = new Map<string, GitHubReviewComment[]>();
  repliesPosted: Array<{ repoFullName: string; prNumber: number; commentId: number; body: string }> = [];
  resolvedThreads: Array<{ repoFullName: string; prNumber: number; commentId: number }> = [];
  labelChanges: Array<{ repoFullName: string; issueNumber: number; add?: string[]; remove?: string[] }> = [];
  createdPrs: PullRequest[] = [];
  createdPrInputs: CreatePullRequestInput[] = [];

  async getIssue(repoFullName: string, issueNumber: number): Promise<GitHubIssue> {
    const i = this.issues.get(`${repoFullName}/${issueNumber}`);
    if (!i) throw new Error(`no issue ${repoFullName}#${issueNumber}`);
    return i;
  }

  async getPr(repoFullName: string, prNumber: number): Promise<PullRequestDetail> {
    const pr = this.prs.get(`${repoFullName}/${prNumber}`);
    if (!pr) throw new Error(`no pr ${repoFullName}#${prNumber}`);
    return pr;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
    this.createdPrInputs.push(input);
    const pr: PullRequest = {
      number: this.createdPrs.length + 1,
      url: `https://example/pr/${this.createdPrs.length + 1}`,
      state: 'open',
    };
    this.createdPrs.push(pr);
    return pr;
  }

  async listReviewComments(repoFullName: string, prNumber: number): Promise<GitHubReviewComment[]> {
    return this.comments.get(`${repoFullName}/${prNumber}`) ?? [];
  }

  async listPrCommentsSince(
    repoFullName: string,
    prNumber: number,
    sinceIso: string,
  ): Promise<GitHubReviewComment[]> {
    const all = this.comments.get(`${repoFullName}/${prNumber}`) ?? [];
    const since = new Date(sinceIso);
    return all.filter((c) => c.createdAt >= since);
  }

  async replyToReviewComment(
    repoFullName: string,
    prNumber: number,
    commentId: number,
    body: string,
  ): Promise<void> {
    this.repliesPosted.push({ repoFullName, prNumber, commentId, body });
  }

  async resolveReviewThread(repoFullName: string, prNumber: number, commentId: number): Promise<void> {
    this.resolvedThreads.push({ repoFullName, prNumber, commentId });
  }

  async updateIssueLabels(
    repoFullName: string,
    issueNumber: number,
    labels: { add?: string[]; remove?: string[] },
  ): Promise<void> {
    this.labelChanges.push({ repoFullName, issueNumber, ...labels });
  }
}
```

- [ ] **Step 6: Fix any other references to the renamed type**

Run: `grep -rn "PrReviewComment" packages/application/src/ports apps/ | grep -v pr-review-repository`
For each hit referring to the **GitHub wire shape**, change `PrReviewComment` → `GitHubReviewComment`. (Domain `PrReviewComment` from `@ai-sdlc/domain` stays.)

- [ ] **Step 7: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/application test -- fake-github-port && pnpm --filter @ai-sdlc/application typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/application/src/ports/github-port.ts packages/application/src/ports/index.ts packages/application/src/test-doubles/fake-github-port.ts packages/application/src/__tests__/fake-github-port.test.ts
git commit -m "feat(application): extend GitHubPort with getPr/resolveReviewThread; rename raw comment type (M6-02)"
```

---

### Task 2: Fake `gh` shim fixtures

**Files:**
- Create: `packages/infrastructure/src/github/__fixtures__/fake-gh-success.sh`
- Create: `packages/infrastructure/src/github/__fixtures__/fake-gh-fail.sh`

- [ ] **Step 1: Create a configurable success shim**

The shim dispatches on the first args and echoes canned JSON. Mark executable.

```bash
# packages/infrastructure/src/github/__fixtures__/fake-gh-success.sh
#!/usr/bin/env bash
# Fake `gh` for adapter tests. Dispatches on argv and prints canned JSON.
# Records every invocation to $FAKE_GH_LOG (one line per call) so tests can assert.
set -uo pipefail
[[ -n "${FAKE_GH_LOG:-}" ]] && printf '%s\n' "$*" >> "$FAKE_GH_LOG"

case "$1 ${2:-}" in
  "issue view")
    echo '{"number":7,"title":"T","body":"B","labels":[{"name":"bug"}]}' ;;
  "pr view")
    echo '{"number":5,"url":"https://x/pr/5","state":"OPEN","headRefName":"feat-x"}' ;;
  "api graphql")
    # resolveReviewThread query or mutation — return minimal success
    echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[{"id":"T_1","isResolved":false,"comments":{"nodes":[{"databaseId":9001}]}}]}}}}}' ;;
  "api"*)
    # REST: pulls/.../comments listing
    echo '[{"id":9001,"path":"a.ts","line":3,"user":{"login":"octocat"},"body":"fix","created_at":"2026-06-04T00:00:00Z","in_reply_to_id":null}]' ;;
  "issue edit")
    : ;;  # label edit, no output
  *)
    echo "unhandled args: $*" >&2; exit 64 ;;
esac
```

- [ ] **Step 2: Create a failing shim** (always exits non-zero with a 5xx-looking message)

```bash
# packages/infrastructure/src/github/__fixtures__/fake-gh-fail.sh
#!/usr/bin/env bash
set -uo pipefail
echo 'HTTP 503: Service Unavailable (https://api.github.com)' >&2
exit 1
```

- [ ] **Step 3: Make them executable + commit**

```bash
chmod +x packages/infrastructure/src/github/__fixtures__/fake-gh-success.sh packages/infrastructure/src/github/__fixtures__/fake-gh-fail.sh
git add packages/infrastructure/src/github/__fixtures__/
git commit -m "test(infra): fake gh shims for GhCliAdapter (M6-02)"
```

---

### Task 3: GhCliAdapter — reads (getIssue, getPr, listReviewComments)

**Files:**
- Create: `packages/infrastructure/src/github/gh-cli-adapter.ts`
- Create: `packages/infrastructure/src/github/errors.ts`
- Test: `packages/infrastructure/src/github/__tests__/gh-cli-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/infrastructure/src/github/__tests__/gh-cli-adapter.test.ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GhCliAdapter } from '../gh-cli-adapter.js';
import { GitHubFailedError } from '../errors.js';

const fixtures = join(fileURLToPath(new URL('.', import.meta.url)), '..', '__fixtures__');
const ok = new GhCliAdapter({ ghPath: join(fixtures, 'fake-gh-success.sh'), maxRetries: 0 });
const bad = new GhCliAdapter({ ghPath: join(fixtures, 'fake-gh-fail.sh'), maxRetries: 1, backoffMs: 1 });

describe('GhCliAdapter reads', () => {
  it('parses an issue', async () => {
    const issue = await ok.getIssue('o/r', 7);
    expect(issue.title).toBe('T');
    expect(issue.labels).toEqual(['bug']);
  });

  it('parses PR metadata and normalises state to lowercase', async () => {
    const pr = await ok.getPr('o/r', 5);
    expect(pr.headRefName).toBe('feat-x');
    expect(pr.state).toBe('open');
  });

  it('maps review comments from REST shape', async () => {
    const cs = await ok.listReviewComments('o/r', 5);
    expect(cs[0]).toMatchObject({ id: 9001, path: 'a.ts', reviewer: 'octocat', inReplyToId: undefined });
  });

  it('throws GitHubFailedError after retries exhausted', async () => {
    await expect(bad.getIssue('o/r', 7)).rejects.toBeInstanceOf(GitHubFailedError);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/infrastructure test -- gh-cli-adapter`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the error type**

```typescript
// packages/infrastructure/src/github/errors.ts
export class GitHubFailedError extends Error {
  readonly command: string;
  readonly stderr: string;
  constructor(command: string, stderr: string) {
    super(`gh command failed: ${command}\n${stderr}`);
    this.name = 'GitHubFailedError';
    this.command = command;
    this.stderr = stderr;
  }
}
```

- [ ] **Step 4: Write the adapter (reads + retry helper)**

```typescript
// packages/infrastructure/src/github/gh-cli-adapter.ts
import { execa } from 'execa';
import type {
  GitHubPort,
  GitHubIssue,
  PullRequestDetail,
  GitHubReviewComment,
  CreatePullRequestInput,
  PullRequest,
} from '@ai-sdlc/application/ports';
import { GitHubFailedError } from './errors.js';

export interface GhCliAdapterOptions {
  ghPath?: string;
  maxRetries?: number;
  backoffMs?: number;
}

interface RestComment {
  id: number;
  path: string;
  line: number | null;
  user: { login: string };
  body: string;
  created_at: string;
  in_reply_to_id: number | null;
}

export class GhCliAdapter implements GitHubPort {
  private readonly gh: string;
  private readonly maxRetries: number;
  private readonly backoffMs: number;

  constructor(opts: GhCliAdapterOptions = {}) {
    this.gh = opts.ghPath ?? 'gh';
    this.maxRetries = opts.maxRetries ?? 2;
    this.backoffMs = opts.backoffMs ?? 1000;
  }

  /** Runs `gh <args>` with retry/backoff on non-zero exit; returns stdout. */
  private async run(args: string[]): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const { stdout } = await execa(this.gh, args, { reject: true });
        return stdout;
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, this.backoffMs * (attempt + 1)));
        }
      }
    }
    const stderr =
      (lastErr as { stderr?: string })?.stderr ?? (lastErr as Error)?.message ?? 'unknown';
    throw new GitHubFailedError(`${this.gh} ${args.join(' ')}`, String(stderr));
  }

  async getIssue(repoFullName: string, issueNumber: number): Promise<GitHubIssue> {
    const out = await this.run([
      'issue', 'view', String(issueNumber),
      '--repo', repoFullName, '--json', 'number,title,body,labels',
    ]);
    const j = JSON.parse(out) as { number: number; title: string; body: string; labels: Array<{ name: string }> };
    return { number: j.number, title: j.title, body: j.body, labels: j.labels.map((l) => l.name) };
  }

  async getPr(repoFullName: string, prNumber: number): Promise<PullRequestDetail> {
    const out = await this.run([
      'pr', 'view', String(prNumber),
      '--repo', repoFullName, '--json', 'number,url,state,headRefName',
    ]);
    const j = JSON.parse(out) as { number: number; url: string; state: string; headRefName: string };
    return {
      number: j.number,
      url: j.url,
      state: j.state.toLowerCase() as PullRequest['state'],
      headRefName: j.headRefName,
    };
  }

  async listReviewComments(repoFullName: string, prNumber: number): Promise<GitHubReviewComment[]> {
    const out = await this.run([
      'api', '--paginate', `repos/${repoFullName}/pulls/${prNumber}/comments`,
    ]);
    return this.parseComments(out, prNumber);
  }

  async listPrCommentsSince(
    repoFullName: string,
    prNumber: number,
    sinceIso: string,
  ): Promise<GitHubReviewComment[]> {
    const all = await this.listReviewComments(repoFullName, prNumber);
    const since = new Date(sinceIso);
    return all.filter((c) => c.createdAt >= since);
  }

  private parseComments(out: string, prNumber: number): GitHubReviewComment[] {
    // --paginate concatenates JSON arrays; tolerate either one array or many.
    const arrays = out.trim()
      ? out
          .trim()
          .split(/\n(?=\[)/)
          .map((chunk) => JSON.parse(chunk) as RestComment[])
      : [];
    const flat = arrays.flat();
    return flat.map((c) => ({
      id: c.id,
      prNumber,
      path: c.path,
      line: c.line ?? 0,
      reviewer: c.user.login,
      body: c.body,
      createdAt: new Date(c.created_at),
      ...(c.in_reply_to_id !== null ? { inReplyToId: c.in_reply_to_id } : {}),
    }));
  }

  // write methods added in Task 4
  async createPullRequest(_input: CreatePullRequestInput): Promise<PullRequest> {
    throw new Error('not implemented until Task 4');
  }
  async replyToReviewComment(): Promise<void> {
    throw new Error('not implemented until Task 4');
  }
  async resolveReviewThread(): Promise<void> {
    throw new Error('not implemented until Task 4');
  }
  async updateIssueLabels(): Promise<void> {
    throw new Error('not implemented until Task 4');
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/infrastructure test -- gh-cli-adapter`
Expected: PASS (read tests + retry test).

- [ ] **Step 6: Commit**

```bash
git add packages/infrastructure/src/github/gh-cli-adapter.ts packages/infrastructure/src/github/errors.ts packages/infrastructure/src/github/__tests__/gh-cli-adapter.test.ts
git commit -m "feat(infra): GhCliAdapter reads + retry/backoff (M6-02)"
```

---

### Task 4: GhCliAdapter — writes (reply, resolve thread, labels, createPR)

**Files:**
- Modify: `packages/infrastructure/src/github/gh-cli-adapter.ts`
- Test: extend `packages/infrastructure/src/github/__tests__/gh-cli-adapter.test.ts`

- [ ] **Step 1: Add failing tests for the write paths**

Append to the test file:

```typescript
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('GhCliAdapter writes', () => {
  it('posts a reply via the REST replies endpoint', async () => {
    const log = join(tmpdir(), `gh-log-${Date.now()}.txt`);
    writeFileSync(log, '');
    const adapter = new GhCliAdapter({
      ghPath: join(fixtures, 'fake-gh-success.sh'),
      maxRetries: 0,
      env: { FAKE_GH_LOG: log },
    });
    await adapter.replyToReviewComment('o/r', 5, 9001, 'thanks');
    const calls = readFileSync(log, 'utf-8');
    expect(calls).toContain('api repos/o/r/pulls/5/comments/9001/replies --method POST');
    rmSync(log, { force: true });
  });

  it('resolves a review thread via graphql', async () => {
    const adapter = new GhCliAdapter({ ghPath: join(fixtures, 'fake-gh-success.sh'), maxRetries: 0 });
    await expect(adapter.resolveReviewThread('o/r', 5, 9001)).resolves.toBeUndefined();
  });

  it('updates issue labels', async () => {
    const adapter = new GhCliAdapter({ ghPath: join(fixtures, 'fake-gh-success.sh'), maxRetries: 0 });
    await expect(
      adapter.updateIssueLabels('o/r', 7, { add: ['ai:pr-ready'], remove: ['ai:in-progress'] }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Add an `env` option** to `GhCliAdapterOptions` and thread it into `execa`:

```typescript
// in GhCliAdapterOptions
  env?: Record<string, string>;

// constructor: store it
  private readonly env: Record<string, string>;
  // ... this.env = opts.env ?? {};

// in run(): pass env
const { stdout } = await execa(this.gh, args, { reject: true, env: { ...process.env, ...this.env } });
```

- [ ] **Step 3: Run to verify fail**

Run: `pnpm --filter @ai-sdlc/infrastructure test -- gh-cli-adapter`
Expected: FAIL — write methods throw "not implemented".

- [ ] **Step 4: Implement the write methods** (replace the stubs from Task 3 Step 4)

```typescript
async createPullRequest(input: CreatePullRequestInput): Promise<PullRequest> {
  const args = [
    'pr', 'create', '--repo', input.repoFullName,
    '--base', input.baseBranch, '--head', input.headBranch,
    '--title', input.title, '--body', input.body,
  ];
  if (input.draft) args.push('--draft');
  const out = await this.run(args); // gh prints the PR URL
  const url = out.trim().split('\n').pop() ?? '';
  const numMatch = url.match(/\/pull\/(\d+)/);
  return { number: numMatch ? Number(numMatch[1]) : 0, url, state: 'open' };
}

async replyToReviewComment(
  repoFullName: string,
  prNumber: number,
  commentId: number,
  body: string,
): Promise<void> {
  await this.run([
    'api', `repos/${repoFullName}/pulls/${prNumber}/comments/${commentId}/replies`,
    '--method', 'POST', '--raw-field', `body=${body}`,
  ]);
}

async resolveReviewThread(
  repoFullName: string,
  prNumber: number,
  commentId: number,
): Promise<void> {
  const [owner, repo] = repoFullName.split('/');
  const query = `query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100){nodes{id isResolved comments(first:50){nodes{databaseId}}}}}}}`;
  const out = await this.run([
    'api', 'graphql', '-f', `query=${query}`,
    '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `pr=${prNumber}`,
  ]);
  const data = JSON.parse(out) as {
    data: { repository: { pullRequest: { reviewThreads: { nodes: Array<{ id: string; isResolved: boolean; comments: { nodes: Array<{ databaseId: number }> } }> } } } };
  };
  const thread = data.data.repository.pullRequest.reviewThreads.nodes.find(
    (t) => !t.isResolved && t.comments.nodes.some((c) => c.databaseId === commentId),
  );
  if (!thread) return; // already resolved or not found — idempotent no-op
  const mutation = `mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}`;
  await this.run(['api', 'graphql', '-f', `query=${mutation}`, '-F', `id=${thread.id}`]);
}

async updateIssueLabels(
  repoFullName: string,
  issueNumber: number,
  labels: { add?: string[]; remove?: string[] },
): Promise<void> {
  const args = ['issue', 'edit', String(issueNumber), '--repo', repoFullName];
  for (const l of labels.add ?? []) args.push('--add-label', l);
  for (const l of labels.remove ?? []) args.push('--remove-label', l);
  if (args.length === 5) return; // nothing to change
  await this.run(args);
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @ai-sdlc/infrastructure test -- gh-cli-adapter`
Expected: PASS.

- [ ] **Step 6: Export from the infra barrel + commit**

In `packages/infrastructure/src/index.ts` add:

```typescript
export { GhCliAdapter } from './github/gh-cli-adapter.js';
export { GitHubFailedError } from './github/errors.js';
```

```bash
git add packages/infrastructure/src/github/gh-cli-adapter.ts packages/infrastructure/src/github/__tests__/gh-cli-adapter.test.ts packages/infrastructure/src/index.ts
git commit -m "feat(infra): GhCliAdapter writes — reply, resolve thread, labels, createPR (M6-02)"
```

---

### Task 5: Opt-in real-`gh` integration test (skipped by default)

**Files:**
- Create: `packages/infrastructure/src/github/__tests__/gh-cli-adapter.integration.test.ts`

- [ ] **Step 1: Write a guarded integration test**

```typescript
// Runs only when GH_INTEGRATION=1 and a real `gh` is authenticated.
import { describe, it, expect } from 'vitest';
import { GhCliAdapter } from '../gh-cli-adapter.js';

const run = process.env.GH_INTEGRATION === '1' ? describe : describe.skip;

run('GhCliAdapter against real gh', () => {
  it('reads a known public issue', async () => {
    const adapter = new GhCliAdapter({});
    const issue = await adapter.getIssue(process.env.GH_TEST_REPO!, Number(process.env.GH_TEST_ISSUE));
    expect(issue.number).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Verify it is skipped in normal runs**

Run: `pnpm --filter @ai-sdlc/infrastructure test -- gh-cli-adapter.integration`
Expected: `0 passed | N skipped` (no real network call).

- [ ] **Step 3: Commit**

```bash
git add packages/infrastructure/src/github/__tests__/gh-cli-adapter.integration.test.ts
git commit -m "test(infra): opt-in real-gh integration suite (M6-02)"
```

---

### Task 6: Final verification

- [ ] **Step 1: Whole workspace green**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r lint && pnpm -r test`
Expected: all green. (Confirms the `PrReviewComment`→`GitHubReviewComment` rename did not break callers.)

---

## Self-review notes

- **Coverage vs. story:** Implements `getIssue`, `getPr`, `listReviewComments`, `listPrCommentsSince`, `replyToReviewComment`, `resolveReviewThread`, `updateIssueLabels`, `createPullRequest`. The story names "getPrState" — covered by `getPr().state`. Retry/backoff + `github_failed` (here `GitHubFailedError`) are present.
- **Command fidelity:** Every `gh` invocation mirrors `scripts/ai-pr-review-poll`. `--paginate` parsing tolerates gh's multi-array concatenation.
- **Injectable `gh` path + env** make the adapter testable with a shim and keep the real-`gh` suite opt-in, satisfying the "stubbed gh drives unit tests; real gh covered by opt-in integration" acceptance.
- **Idempotent thread resolution:** `resolveReviewThread` no-ops when the thread is missing/already resolved, matching the Bash `resolve_threads` skip behaviour.
