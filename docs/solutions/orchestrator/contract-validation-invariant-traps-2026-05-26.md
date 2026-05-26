---
title: Agent contract validation — invariant composition traps and approximate detection
date: 2026-05-26
category: orchestrator
module: packages/application
problem_type: invariant_design
component: validate-agent-contract
symptoms:
  - mustNotChangeBranch falsely triggers when agent commits on same branch
  - mustPostReplies passes when any human comment exists, not agent replies
  - allowedResultValues with missing resultJsonPath should violate, not skip
  - Invariants interact to create false positives when combined
root_cause: invariant_interaction_gap
resolution_type: pattern
severity: high
related_components:
  - packages/domain/src/agent-contract.ts
  - packages/application/src/agent/validate-agent-contract.ts
  - packages/application/src/agent/contract-violation-codes.ts
  - packages/application/src/ports/git-port.ts
  - packages/application/src/ports/github-port.ts
tags:
  - contract-validation
  - invariants
  - mustNotChangeBranch
  - mustPostReplies
  - domain-type-evolution
  - M4-04
---

# Agent Contract Validation — Invariant Composition Traps and Approximate Detection

## Problem

The `validateAgentContract` function checks six invariants after every agent invocation. When invariants are combined in a single contract, they can interact to produce false violations. Individual invariant checks have precision gaps that matter differently depending on whether they're used alone or composed.

## Invariant 1: `mustNotChangeBranch` + `mustCreateCommit` — The Composition Trap

**The false-positive pattern:** When both invariants are active, `mustNotChangeBranch` compares HEAD SHA against `startCommitSha`. If the agent legitimately creates a commit on the same branch, SHA differs → `mustNotChangeBranch` fires a false `branch_changed` violation.

**Root cause:** "HEAD moved" and "branch switched" are distinct events that need separate detection. SHA equality conflates them.

**Resolution:** When `expectedBranch` is provided, check branch name only (`currentBranch !== expectedBranch`). Only fall back to SHA comparison when no `expectedBranch` is given (SHA-only mode). This means `mustNotChangeBranch` detects branch switching, while `mustCreateCommit` detects commits — each invariant handles its own concern without overlap.

**Three-iteration evolution:**

| Version | Check                                                                  | False positive?                                                 |
| ------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| v1      | Branch name AND SHA                                                    | Yes — agent committing on same branch triggers `branch_changed` |
| v2      | Guard `currentBranch` behind `expectedBranch` check, still compare SHA | Yes — SHA still fires on legitimate commits                     |
| v3      | Branch name only when `expectedBranch` provided                        | No — each invariant is precise                                  |

### Don't call functions whose results you don't use

In detached-HEAD contexts (worktrees, CI runners), `git rev-parse --abbrev-ref HEAD` returns a SHA or throws. The original implementation unconditionally called `currentBranch(cwd)` before checking whether `expectedBranch` was even provided. The catch block emitted `branch_changed` even when HEAD SHA matched `startCommitSha`.

**Fix:** Only call `currentBranch(cwd)` when `expectedBranch !== undefined`. In SHA-only mode, only `headCommitSha(cwd)` is called.

## Invariant 2: `mustPostReplies` — Approximate Detection

**The gap:** The initial implementation passed the check whenever _any_ PR comment existed after `startedAt`, regardless of author. A human reviewer commenting would satisfy the contract even if the agent never replied.

**Resolution:** Added optional `agentAuthor?: string` to the `mustPostReplies` domain type. When provided, filters `comments.filter(c => c.reviewer === agentAuthor)`. When absent, preserves any-comment semantics (backward-compatible default).

**Why not make `agentAuthor` required:** Callers may not know the bot username at contract-definition time. The design doc explicitly scoped precise bot detection as a future enhancement. Optional precision is preferable to over-constraining the API.

**Alternative rejected:** Sentinel marker in comment body — requires agent implementation cooperation and changes the GitHub API contract.

### Missing `repoFullName` → `repo_not_provided`, not silent skip

If `mustPostReplies` is set but `repoFullName` is omitted, the validator returns `repo_not_provided` (a violation code) rather than silently skipping the check or throwing. Throwing violates "never throws for domain failures." Silently skipping hides a configuration error.

## Invariant 3: `allowedResultValues` with Missing `resultJsonPath`

The original plan said to skip the check when `resultJsonPath` is missing. The implementation returns `invalid_result_value` instead.

**Rationale:** If a contract says "the result must be one of ['pass', 'fail']" and the invocation has no result.json path, the invocation is fundamentally non-compliant. The contract expects a result value; one can't be validated. That's a violation, not a pass.

## Cross-Cutting: Domain Type Evolution Mid-Review

Both the `agentAuthor` fix and the `expectedBranch` restructuring required changes to the domain type (`AgentContract`) in the same commit as the application validator. This is a pattern: **reviewer pushback on application-level invariant completeness reveals domain type gaps**.

When adding a new invariant check, verify the domain type carries enough information for the check to be precise — not just enough for a naive implementation. The domain type is the contract; if it's missing a field needed for accurate validation, the validator will either produce false results or need workarounds.

## Violation Codes Used

| Code                        | Invariant             | When                                                       |
| --------------------------- | --------------------- | ---------------------------------------------------------- |
| `missing_required_artifact` | `requiredArtifacts`   | Any artifact file is missing or empty                      |
| `invalid_result_value`      | `allowedResultValues` | Result value not in allowed set, or resultJsonPath missing |
| `branch_changed`            | `mustNotChangeBranch` | Branch name or (fallback) SHA differs                      |
| `missing_commit`            | `mustCreateCommit`    | endCommitSha equals startCommitSha                         |
| `not_pushed`                | `mustPush`            | Remote ref SHA differs from local                          |
| `replies_not_posted`        | `mustPostReplies`     | No matching comments since startedAt                       |
| `repo_not_provided`         | `mustPostReplies`     | repoFullName missing when mustPostReplies is set           |

One violation code per invariant kind. If 3 of 5 `requiredArtifacts` are missing, you get one `missing_required_artifact` — not three. Callers care about _which kinds_ of violations occurred; specific file names are in logs/stderr.

## All Invariant Checks Are Wrapped in try/catch

Git operations (`currentBranch`, `headCommitSha`, `remoteRef`) and GitHub API calls (`listPrCommentsSince`) can fail for infrastructure reasons. Each invariant's observation is wrapped in try/catch — on failure, the invariant returns its violation code rather than propagating the error. This keeps `validateAgentContract` returning violation codes (never throwing for domain failures) even when underlying infrastructure fails.

## Port Extensions Required

Two new port methods were needed beyond the initial design:

- `GitPort.remoteRef({ cwd, remote, ref })` → returns SHA or `undefined` (mirrors `git ls-remote`)
- `GitHubPort.listPrCommentsSince(repoFullName, prNumber, sinceIso)` → returns comments after a timestamp

These are separate methods rather than overloads on existing `listReviewComments` — clearer and avoids changing existing callers.

## Adding a New Invariant

1. Add the field to `AgentContract` in `packages/domain/src/agent-contract.ts`
2. Add the violation code to `CONTRACT_VIOLATION_CODES` in `packages/application/src/agent/contract-violation-codes.ts`
3. Add the check to `validateAgentContract` in `packages/application/src/agent/validate-agent-contract.ts`
4. Wrap the observation in try/catch — return the violation code on infra failure
5. Test: passing case, failing case, and composed-with-other-invariants case
6. Verify the domain type carries enough information for the check to be precise

## Gotchas

1. **`AgentInvocation.resultJsonPath` must be a relative path.** `ArtifactStore.read(runId, relativePath)` expects relative paths. Passing an absolute filesystem path will fail.

2. **`FakeGitPort.currentBranch()` and `headCommitSha()` throw if not set.** Tests must call `git.currentBranchByCwd.set(cwd, branch)` and `git.headByCwd.set(cwd, sha)` before using. If a test invokes `mustNotChangeBranch` without setup, the catch block emits `branch_changed`.

3. **`FakeGitPort.remoteRefs` uses `"remote/ref"` as key.** `git.remoteRefs.set('origin/main', sha)` — format is `"${remote}/${ref}"`.

4. **`endCommitSha` fallback to `headCommitSha(cwd)` is live.** When undefined, the validator queries the live repo state. If the caller needs a snapshot, `endCommitSha` must be populated before validation.

5. **`mustPostReplies` is approximate.** When `agentAuthor` is omitted, any comment satisfies the check. When provided, it checks `reviewer === agentAuthor` (case-sensitive).
