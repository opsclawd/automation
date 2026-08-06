<!-- plan-review-required -->
# Safe create-pr Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure the `create-pr` Phase only reuses an open pull request, creates a replacement for a stale merged or closed pull request when the branch has new work, and fails clearly when it cannot preserve that guarantee.

**Architecture:** Keep the policy in the application-layer `CreatePrHandler`, using the existing `GitHubPort.getPr` and `GitPort.isAncestor` contracts already implemented by production and fake adapters. Treat `pr-url.txt` as the identity of the exact pull request to inspect, preserve it as the idempotency artifact for any newly created pull request, and make issue-label transition failures part of the Phase outcome.

**Tech Stack:** TypeScript, Vitest, existing application ports/test doubles, pnpm workspace tooling.

---

## Goal

Prevent a Run from progressing past `create-pr` with commits stranded outside an open pull request. An existing `pr-url.txt` may yield the reuse outcome only after its pull request is parsed and confirmed open; merged and closed pull requests lead to the normal creation path, subject to a no-empty-branch gate.

## Non-goals

- Do not search for pull requests by the reusable `ai/issue-N` branch name.
- Do not always create a new pull request; an open pull request named by `pr-url.txt` remains the correct idempotent result.
- Do not close, reopen, edit, or otherwise mutate the stale pull request.
- Do not fetch refs or change how `baseBranch` is resolved; use `ctx.baseBranch ?? 'main'` and the refs already available to the Phase.
- Do not change post-PR polling, Run lifecycle definitions, port contracts, infrastructure adapters, or `create-pr` retry-safety metadata.
- Do not make orchestrator-artifact cleanup fatal; only PR-state, ancestry, pull-request creation, artifact persistence, and label-transition failures affect this plan.

## Affected files

- `packages/application/src/phases/handlers/create-pr.ts` — validate an artifact-backed PR before reuse, gate creation on branch ancestry, and return failures for label-transition errors.
- `packages/application/src/phases/handlers/__tests__/create-pr.test.ts` — add named regression cases for each state transition and failure path; the existing file has more than ten cases, so the work is split into three behavior-focused tasks rather than one oversized test-update task.

Read-only context files:

- `packages/application/src/ports/github-port.ts` — existing `GitHubPort.getPr`, `PullRequestDetail.state`, and `updateIssueLabels` contracts.
- `packages/application/src/ports/git-port.ts` — existing `GitPort.isAncestor` contract.
- `packages/application/src/test-doubles/fake-github-port.ts` — existing PR map and recorded creation/label calls.
- `packages/application/src/test-doubles/fake-git-port.ts` — existing configurable ancestry results.
- `packages/infrastructure/src/github/gh-cli-adapter.ts` — confirms production PR states normalize to `open | closed | merged`.
- `packages/infrastructure/src/git/git-worktree-adapter.ts` — confirms ancestry argument order maps to `git merge-base --is-ancestor`.

## Behavioral model

The artifact-backed PR decision is a small state machine:

| Input/state | Required transition |
| --- | --- |
| `pr-url.txt` absent | Continue to the normal create path. |
| Artifact URL invalid or PR lookup fails | Return a failed Phase; do not guess by branch or create another PR. |
| Artifact PR is `open` | Reuse its URL, transition labels, then pass. |
| Artifact PR is `merged` or `closed` and head is not contained in base | Ignore the stale URL, create a replacement PR, persist the replacement URL, transition labels, then pass. |
| Creation path and head is already contained in base | Return a failed Phase before push or PR creation. |
| Any label transition fails | Return a failed Phase and do not emit completion; if a PR was just created, its URL must already be durable so resume cannot duplicate it. |

## Task 1: Validate artifact-backed pull request state

**Files:**

- Modify: `packages/application/src/phases/handlers/create-pr.ts` (Stage 1 idempotency branch and a module-local PR-number parser)
- Test: `packages/application/src/phases/handlers/__tests__/create-pr.test.ts` (existing idempotency case plus new open/merged/closed/invalid/lookup-error cases only)
- Read: `packages/application/src/ports/github-port.ts`
- Read: `packages/application/src/test-doubles/fake-github-port.ts`

**Behavioral invariants (write these named tests first):**

- `reuses pr-url.txt only when the referenced pull request is open`: given a valid artifact URL and an `open` PR detail, call `getPr` for that exact number, create no PR, preserve the artifact, emit `pr.reused`, update labels once, and pass.
- `creates a replacement pull request when pr-url.txt references a merged pull request`: given a `merged` PR detail, do not emit `pr.reused`; proceed through the existing summary/push/create path and replace the artifact with the new URL.
- `creates a replacement pull request when pr-url.txt references a closed pull request`: apply the same replacement behavior for `closed`.
- `fails when pr-url.txt is not a parseable pull request URL`: return `github_failed`, create and push nothing, update no labels, and provide a diagnostic containing the invalid artifact value.
- `fails when the pull request referenced by pr-url.txt cannot be inspected`: if `getPr` throws, return `github_failed`, create and push nothing, and preserve the lookup error in the diagnostic.

- [ ] **Step 1: Replace and extend the Stage 1 tests so they fail against the unconditional reuse behavior.**

Seed the fake by its existing key convention and use real pull-request URL shapes:

```ts
const existingUrl = 'https://github.com/acme/widgets/pull/42';
github.prs.set('acme/widgets/42', {
  number: 42,
  url: existingUrl,
  state: 'open',
  headRefName: 'feat/issue-7',
});
```

For the merged and closed cases, change `state`, run the handler, and assert `github.createdPrInputs` has one entry and the rewritten `pr-url.txt` equals the fake's newly created URL. For invalid/lookup failure, assert `git.pushes`, `createdPrInputs`, and `labelChanges` are empty and no `create_pr.completed` event exists.

- [ ] **Step 2: Run only this state-decision subset and confirm the new cases fail for the intended reason.**

Run:

```bash
pnpm --filter @ai-sdlc/application exec vitest run src/phases/handlers/__tests__/create-pr.test.ts -t "(reuses pr-url.txt only|creates a replacement pull request|fails when pr-url.txt|fails when the pull request referenced)"
```

Expected before implementation: the open case fails because `getPr` is not called, merged/closed cases incorrectly reuse, and malformed/lookup-error cases incorrectly pass.

- [ ] **Step 3: Parse and inspect the artifact-backed PR before deciding whether to return early.**

Add a module-local helper that accepts normal and enterprise-host GitHub URLs without binding behavior to a particular hostname, rejects non-HTTP(S) or non-PR paths, and returns only a positive integer:

```ts
function _parsePrNumber(prUrl: string): number | undefined {
  try {
    const parsed = new URL(prUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    const match = parsed.pathname.match(/\/pull\/([1-9]\d*)\/?$/);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}
```

In Stage 1, fail with `github_failed` and `canRetry: false` when parsing fails. Otherwise call `ctx.github.getPr(ctx.repoFullName, prNumber)` inside a guarded block; on lookup failure, emit `create_pr.failed` and return `github_failed` with `canRetry: true`. Keep the current early-return reuse flow only for `pr.state === 'open'`. For `merged` and `closed`, emit an informational stale-PR event with the old number, URL, and state, leave `prUrl` available only as historical context, and fall through to summary assembly and creation. Do not look up by branch name.

- [ ] **Step 4: Run the focused cases and lint both changed files.**

Run:

```bash
pnpm --filter @ai-sdlc/application exec vitest run src/phases/handlers/__tests__/create-pr.test.ts -t "(reuses pr-url.txt only|creates a replacement pull request|fails when pr-url.txt|fails when the pull request referenced)"
pnpm exec eslint packages/application/src/phases/handlers/create-pr.ts packages/application/src/phases/handlers/__tests__/create-pr.test.ts
```

Expected: all selected cases pass and ESLint exits zero.

- [ ] **Step 5: Commit the independently passing PR-state slice.**

```bash
git add packages/application/src/phases/handlers/create-pr.ts packages/application/src/phases/handlers/__tests__/create-pr.test.ts
git commit -m "fix(create-pr): validate PR state before reuse"
```

## Task 2: Block empty replacement pull requests

**Files:**

- Modify: `packages/application/src/phases/handlers/create-pr.ts` (creation path between base/head resolution and push)
- Test: `packages/application/src/phases/handlers/__tests__/create-pr.test.ts` (ancestry gate cases only)
- Read: `packages/application/src/ports/git-port.ts`
- Read: `packages/application/src/test-doubles/fake-git-port.ts`
- Read: `packages/infrastructure/src/git/git-worktree-adapter.ts`

**Behavioral invariants (write these named tests first):**

- `fails before push when the head branch is already contained in the base branch`: when `isAncestor(headBranch, baseBranch)` is true on any creation path, return `git_failed`, create no PR, push nothing, update no labels, and report that there are no new commits.
- `creates a replacement for a merged pull request when the head branch has new commits`: when the stale artifact PR is merged and the ancestry result is false, push and create exactly one replacement PR.
- `fails when branch ancestry cannot be determined`: when `isAncestor` throws, return `git_failed`, preserve the underlying error in the diagnostic, and perform no push, PR creation, or label update.

- [ ] **Step 1: Add focused ancestry-gate tests using the existing fake result map or a method spy.**

Configure the fully merged case with the exact argument order expected by the port:

```ts
git.ancestorResults.set('feat/issue-7|main', true);
```

Use `vi.spyOn(git, 'isAncestor').mockRejectedValue(...)` for the error case. In both failures assert the result kind, diagnostic, absent side effects, `create_pr.failed`, and absence of `create_pr.completed`.

- [ ] **Step 2: Run the ancestry subset and confirm the fully merged and error cases fail before implementation.**

Run:

```bash
pnpm --filter @ai-sdlc/application exec vitest run src/phases/handlers/__tests__/create-pr.test.ts -t "(fails before push when the head branch|creates a replacement for a merged|fails when branch ancestry)"
```

Expected before implementation: the handler pushes/creates despite a true ancestry result and never observes an ancestry error.

- [ ] **Step 3: Add a guarded empty-branch check to every creation path.**

Resolve `headBranch` once alongside `baseBranch`, then call:

```ts
const fullyMerged = await ctx.git.isAncestor(ctx.cwd, headBranch, baseBranch);
```

Place the check after summary assembly/artifact cleanup but before push, so no remote side effect occurs for an empty branch. If it returns true, emit `create_pr.failed` and return `git_failed` with `canRetry: false`, a message naming both refs and stating that the head has no commits outside the base, and a suggested action to add new commits or stop the Run. If the call throws, return `git_failed` with `canRetry: true` and a suggested action to verify local refs. Reuse `headBranch` for push and `createPullRequest` so the checked and published refs cannot diverge.

- [ ] **Step 4: Run the focused cases and lint both changed files.**

Run:

```bash
pnpm --filter @ai-sdlc/application exec vitest run src/phases/handlers/__tests__/create-pr.test.ts -t "(fails before push when the head branch|creates a replacement for a merged|fails when branch ancestry)"
pnpm exec eslint packages/application/src/phases/handlers/create-pr.ts packages/application/src/phases/handlers/__tests__/create-pr.test.ts
```

Expected: all selected cases pass and ESLint exits zero.

- [ ] **Step 5: Commit the independently passing ancestry-gate slice.**

```bash
git add packages/application/src/phases/handlers/create-pr.ts packages/application/src/phases/handlers/__tests__/create-pr.test.ts
git commit -m "fix(create-pr): reject fully merged branches"
```

## Task 3: Make issue-label transitions fatal and resume-safe

**Files:**

- Modify: `packages/application/src/phases/handlers/create-pr.ts` (both label-update paths and new-PR artifact ordering)
- Test: `packages/application/src/phases/handlers/__tests__/create-pr.test.ts` (label failure and resume-safety cases only)
- Read: `packages/application/src/ports/github-port.ts`
- Read: `packages/application/src/test-doubles/fake-github-port.ts`

**Behavioral invariants (write these named tests first):**

- `fails when label transition fails while reusing an open pull request`: an `updateIssueLabels` rejection returns `github_failed`, emits an error-level label failure, emits no completion, and creates no new PR.
- `persists a newly created pull request before failing its label transition`: if creation succeeds but labels fail, `pr-url.txt` contains the created URL, the failure lists that artifact, and no completion event is emitted.
- `resumes a created pull request after a label transition failure without creating a duplicate`: rerunning with the persisted URL resolving to `open` retries labels against the same PR and does not call `createPullRequest` again.
- `passes only after the required label transition succeeds`: both open reuse and new creation remove `ai:in-progress`, add `ai:pr-ready`, and emit completion only after the update resolves.

- [ ] **Step 1: Add the label-failure and two-run resume tests.**

Override `updateIssueLabels` with a deterministic rejection. For the creation case, return a real URL/number from `createPullRequest`, seed that PR detail as open before the second handler call, restore a successful label method, and assert the accumulated creation count remains one. This test must prove the durable URL is written before the failed label operation, rather than merely checking the final Phase result.

- [ ] **Step 2: Run the label subset and confirm the handler currently passes despite the rejected update.**

Run:

```bash
pnpm --filter @ai-sdlc/application exec vitest run src/phases/handlers/__tests__/create-pr.test.ts -t "(fails when label transition|persists a newly created|resumes a created pull request|passes only after the required label)"
```

Expected before implementation: label rejection is swallowed, completion is emitted, and the new-PR path has not made the URL durable before attempting labels.

- [ ] **Step 3: Return explicit failures from both label-transition sites and make new-PR ordering idempotent.**

For open reuse, replace the warning-only catch with an error-level `github.label_update_failed` event and a `github_failed` result with `canRetry: true` and a suggestion to restore the issue's expected label state before resuming.

For new creation, move the existing `pr-url.txt` write immediately after `pr.created` and before `updateIssueLabels`; after a successful write, add `pr-url.txt` to `writtenArtifacts`. Preserve the existing non-retryable artifact-write failure because the external PR exists but its idempotency record does not. Then perform the label transition. If it rejects, return `github_failed` with `canRetry: true`: resume is safe because Stage 1 will inspect and reuse the now-durable open PR. Emit `create_pr.completed` only after the label transition succeeds.

The resulting ordering must be:

```text
createPullRequest → write pr-url.txt → updateIssueLabels → create_pr.completed
```

- [ ] **Step 4: Run the focused label tests, then the complete handler test file, and lint both changed files.**

Run:

```bash
pnpm --filter @ai-sdlc/application exec vitest run src/phases/handlers/__tests__/create-pr.test.ts -t "(fails when label transition|persists a newly created|resumes a created pull request|passes only after the required label)"
pnpm --filter @ai-sdlc/application exec vitest run src/phases/handlers/__tests__/create-pr.test.ts
pnpm exec eslint packages/application/src/phases/handlers/create-pr.ts packages/application/src/phases/handlers/__tests__/create-pr.test.ts
```

Expected: the focused cases and all pre-existing `CreatePrHandler` cases pass; ESLint exits zero.

- [ ] **Step 5: Commit the independently passing label-transition slice.**

```bash
git add packages/application/src/phases/handlers/create-pr.ts packages/application/src/phases/handlers/__tests__/create-pr.test.ts
git commit -m "fix(create-pr): fail unsafe label transitions"
```

## Tests to add or update

- Replace the old unconditional-idempotency test with an open-state-specific reuse test that seeds `FakeGitHubPort.prs`.
- Add merged and closed replacement cases tied to the exact PR number parsed from `pr-url.txt`.
- Add invalid-URL and `getPr` failure cases proving that an unverifiable artifact cannot trigger reuse or speculative creation.
- Add true/false/error ancestry cases proving creation is permitted only when the head has commits outside the base.
- Add label-failure cases for open reuse and new creation, including a two-run regression proving artifact-first ordering prevents duplicate pull requests.
- Keep all existing deterministic summary, validation gate, cleanup, push, and creation failure tests passing.

## Validation commands

Task-level commands are listed within each task and target only the two changed files or named test subsets. After all implementation tasks, the repository's dedicated validate Phase must run the mandatory repository gates (this is not a standalone implementation task):

```bash
pnpm -r build
pnpm -r typecheck
pnpm lint
pnpm -r test
```

All four must pass from a clean implementation worktree before a PR is opened. Because this plan changes no cross-package imports, `pnpm boundaries` is not an additional task-specific requirement.

## Risk areas

- An overly permissive URL parser could inspect the wrong number; an overly restrictive parser could reject valid enterprise-host URLs. Match URL structure, not hostname, and require a positive numeric `/pull/<number>` terminal path.
- `getPr` is a new network operation on the reuse path. Failure must stop the Phase because treating an unverifiable PR as either open or stale can respectively strand commits or create a duplicate.
- `isAncestor` argument order is easy to reverse. The head branch must be the ancestor candidate and the base branch the descendant candidate: `isAncestor(cwd, headBranch, baseBranch)`.
- The local base ref may be stale. This plan intentionally follows the design assumption that refs are available/current at this Phase; it does not add fetching.
- A pull request is an irreversible external side effect. Persisting its URL before a potentially failing label transition is required to make resume idempotent.
- Strict label handling may expose manual issue-label drift as more Run failures. That is intentional: successful PR readiness requires the expected issue-state transition.
- Multiple tasks touch the same handler and test file. Each task must begin from the previous task's passing commit and restrict test edits to its named behavior subset.

## Stop conditions

- Stop if `GitHubPort.getPr` or `GitPort.isAncestor` is absent or has semantics different from the inspected contracts; resolving that would require a port/adapter expansion not authorized by this plan and must be replanned with port plus every adapter in one task.
- Stop if `pr-url.txt` is not the canonical artifact consumed by post-PR behavior in the current branch; changing artifact identity would broaden the lifecycle scope.
- Stop if production PR states are not normalized to `open | closed | merged`; do not silently invent another state policy.
- Stop if the implementation cannot persist a newly created PR URL before returning a label failure; continuing would retain the duplicate-PR hazard.
- Stop if the ancestry check requires fetching or mutating refs to be reliable in the actual composition path; remote synchronization is explicitly outside this design and needs a new decision.
- Stop if any task's focused tests expose unrelated source changes or pre-existing failures that make the task non-independently committable; report the evidence rather than weakening assertions or expanding scope.

## Assumptions

- HTTP(S) GitHub and GitHub Enterprise PR URLs end in `/pull/<positive integer>`, optionally with a trailing slash, query, or fragment handled by URL parsing.
- `ctx.github.getPr` returns lowercase normalized states, as declared by `PullRequestDetail` and implemented by `GhCliAdapter`.
- `ctx.git.isAncestor(ctx.cwd, headBranch, baseBranch)` answers whether all head commits are already reachable from base.
- A failed label transition is safely retryable only when an open PR URL is already durable; therefore the new-PR path writes `pr-url.txt` before labels.
- No exported API signature changes are necessary; the parser and any small control-flow helpers remain module-local.
