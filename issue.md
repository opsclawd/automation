# create-pr reuses a MERGED pull request, so runs report 'passed' with their commits stranded and unmerged

## Goal

`create-pr` reuses an existing PR URL for a branch without checking whether that PR is already merged or closed. When it is, the phase reports success and `post-pr-review` sees "PR merged — phase complete", so a run finishes `passed` while the commits it produced are unmerged and have no open PR.

## Verified evidence

Run `67c7466e-ddaf-49ca-a209-1b6383bb91e7` (target repo `opsclawd/sol-usdc-clmm-intelligence`, issue 159):

```
[ts] reusing existing PR url https://github.com/opsclawd/sol-usdc-clmm-intelligence/pull/162
[ts] label update failed: 'ai:in-progress' not found
[ts] create-pr complete
[ts] post-pr-review started
[ts] PR merged — phase complete
status: "passed"
```

PR #162 was already `MERGED` (at 14:00:29) from head branch `ai/issue-159`. The run started at 16:20 from `startCommitSha 0e99710`, pushed two further commits to that same branch, and reused #162's URL. Those commits were never part of #162's merge:

```
$ git log origin/main..origin/ai/issue-159 --oneline
0e99710 fix: review findings
b59ea32 fix: cap complete quality on missing context
```

The run therefore reported success with the work stranded. The accompanying `'ai:in-progress' not found` label error is the same signal — the issue was never in the state this run assumed.

## Anchored design

In `create-pr`, when an existing PR is found for the head branch, check its state. If it is `MERGED` or `CLOSED`, do not reuse it — open a new PR (and, if the branch is already contained in the base, fail loudly rather than silently producing an empty PR).

Reusing a PR URL is only valid while that PR is `OPEN`.

Also worth treating the label-update failure as a signal rather than a warning: if `--remove-label ai:in-progress` reports the label absent, the run's assumptions about issue state are already wrong.

## Explicit traps & non-goals

- **DO NOT** resolve this by always creating a new PR. Reuse is correct and desirable for the resume/retry path when the PR is still open.
- **DO NOT** rely on branch name alone to identify the target PR. `ai/issue-N` is reused across runs for the same issue, which is precisely how a merged PR gets picked up by a later run.
- A run whose commits are not reachable from any open PR must not report `passed`.

## Acceptance criteria

- [ ] `create-pr` reuses an existing PR only when its state is `OPEN`.
- [ ] When the branch's PR is merged or closed, a new PR is created, or the run fails with a clear diagnostic.
- [ ] A run cannot reach terminal `passed` while commits it produced are unmerged and not attached to an open PR.
- [ ] Regression test covering: branch has a merged PR, run pushes new commits, expect a new PR rather than reuse.

