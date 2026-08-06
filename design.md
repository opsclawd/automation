# Design: Fix create-pr reuse of merged PRs

## The problem being solved and why it matters
When `create-pr` runs, it checks for an existing `pr-url.txt` artifact to provide idempotency. If it finds one, it immediately reuses the PR URL and reports success. However, it does not verify the state of the PR on GitHub. If that PR was already `MERGED` or `CLOSED` (e.g. from a previous successful run on the same issue that we are now retrying/resuming), the phase still reports success despite pushing new commits to a branch that is no longer linked to an open PR. Consequently, the new commits are stranded, but the orchestrator considers the phase passed, eventually concluding the run incorrectly.

## Key design decisions and trade-offs considered
1. **How to identify the PR to check:** 
   - *Option A:* Rely solely on branch name (`ai/issue-N`) to find existing PRs using the GitHub API. 
     - *Trade-off:* Branch names are reused across different runs for the same issue. We could accidentally pick up a merged PR from a past run when we intended to create a new one. 
   - *Option B (Chosen):* Continue using `pr-url.txt` to find the exact PR URL created for this context, parse the PR number from it, and query the GitHub API for its state. This respects the idempotency intent while verifying validity.

2. **Handling empty PR creation:**
   - When we detect a closed/merged PR and decide to create a new one, we need to ensure we actually have new commits to propose. 
   - *Chosen Approach:* Use `git isAncestor(headBranch, baseBranch)` to verify that our branch has commits not present in the base branch. If it is already fully merged (an ancestor of the base), fail loudly rather than attempting to create an empty PR.

3. **Label update failure handling:**
   - Currently, updating issue labels (removing `ai:in-progress`, adding `ai:pr-ready`) is treated as a non-fatal warning.
   - *Chosen Approach:* Treat label update failures (especially `'ai:in-progress' not found`) as a signal that the run's assumptions about the issue state are flawed. Make these failures fatal by failing the phase instead of swallowing the error.

## Proposed approach with rationale
1. **Stage 1 (Idempotency):**
   - Read `pr-url.txt`. If it exists, extract the PR number from the URL using a regex.
   - Call `ctx.github.getPr(ctx.repoFullName, prNumber)`.
   - If `pr.state === 'open'`, proceed with the existing reuse path.
   - If `pr.state` is `merged` or `closed`, ignore the old URL (do not return early) and proceed to create a new PR.
2. **Empty branch check:**
   - Before calling `ctx.github.createPullRequest`, check if the head branch is already contained in the base branch using `ctx.git.isAncestor(ctx.cwd, this.opts.headBranch(ctx), baseBranch)`.
   - If true, fail the phase with a `git_failed` or `github_failed` (or similar clear failure) indicating the branch is fully merged and there are no new commits to PR.
3. **Strict Label Updates:**
   - Remove the `try/catch` wrapper that swallows `ctx.github.updateIssueLabels` errors (both in the early-return path and the end-of-phase path). 
   - If `updateIssueLabels` throws, catch it and return a `_fail` outcome, failing the phase so that a run whose commits are not attached to an open PR correctly reports failure if the labels were in an unexpected state.

## Assumptions made
- `prUrl` read from `pr-url.txt` will always be a well-formed GitHub PR URL (e.g., `https://github.com/.../pull/123`), allowing regex extraction of the PR number.
- `gh issue edit` CLI (underlying `updateIssueLabels`) reliably throws an error when attempting to remove a label that is not present on the issue.
- The `baseBranch` parameter will be accurately resolved by `ctx.baseBranch ?? 'main'`, and both head and base branches are available locally for `isAncestor` checks without requiring explicit fetches at this stage.

## In scope and out of scope
**In Scope:**
- Validating the state of existing PRs found via `pr-url.txt`.
- Creating a new PR when the existing one is `merged` or `closed`.
- Preventing empty PR creation by failing if the head branch is an ancestor of the base branch.
- Making label update failures fatal in the `create-pr` phase.

**Out of Scope:**
- Searching for existing PRs via the GitHub API by branch name alone.
- Handling or closing old PRs that are in a bad state (we just create a new one).
- Modifying behavior for scenarios where `pr-url.txt` is missing entirely (normal creation flow applies).

## Risks or concerns identified from code analysis
- **Regex Extraction Risk:** If the URL format in `pr-url.txt` varies (e.g. trailing slash, different domain for enterprise), a simple regex might fail to extract the PR number. The extraction logic must be robust, and if it fails to parse, it should fall back to failing the phase or assuming the URL is invalid.
- **GitHub API Rate Limits:** Adding a `getPr` API call in the hot path of PR reuse introduces an extra network hop. This is acceptable for orchestration phases but relies on robust backoff (which `GhCliAdapter` provides).
- **Label State Drifts:** Making label updates fatal means that if a user manually removes the `ai:in-progress` label while a run is executing, the run will fail at the `create-pr` phase. This is intentional per the design, but enforces strict adherence to label lifecycles.
