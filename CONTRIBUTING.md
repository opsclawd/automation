# Contributing

## Hotfix PRs and parity tests

When a hotfix PR cherry-picks commits from an open feature branch, those
commits may include parity tests in
`scripts/lib/__tests__/legacy-parity.bats`. This creates duplicate parity-test
history across branches, causing conflicts during subsequent sync-merges of
`main` into the feature branch.

**Rule:** Hotfix PRs that cherry-pick from an open branch must **not** include parity tests from that branch. Parity tests belong in the originating PR.

**If a hotfix genuinely needs parity tests (rare):** rebase the originating branch on top of the hotfix merge commit immediately after the merge, so the fork point advances past the cherry-picked commits and no conflicting append region exists.

**CI enforcement:** A CI check (`scripts/check-hotfix-parity-duplicate.sh`) runs
on every `pull_request` event and blocks the merge when it detects parity-test
invariant IDs that also appear in open PRs' branches.
