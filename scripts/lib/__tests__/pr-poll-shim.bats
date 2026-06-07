#!/usr/bin/env bats

@test "ai-pr-review-poll prints usage when no PR given" {
  run scripts/ai-pr-review-poll
  [ "$status" -eq 1 ]
  [[ "$output" == *"Usage:"* ]]
}

@test "ai-pr-review-poll exits 1 when ISSUE_NUM is empty" {
  run scripts/ai-pr-review-poll 42
  [ "$status" -eq 1 ]
  [[ "$output" == *"ISSUE_NUM is required"* ]]
}

@test "ai-pr-review-poll exits 1 when worktree does not exist" {
  run scripts/ai-pr-review-poll 42 999
  [ "$status" -eq 1 ]
  [[ "$output" == *"does not exist"* ]]
}

@test "ai-pr-review-poll exits 1 when OWNER_REPO unset and gh unavailable" {
  fake_bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$fake_bin"
  cat > "$fake_bin/gh" <<'SCRIPT'
#!/usr/bin/env bash
exit 1
SCRIPT
  chmod +x "$fake_bin/gh"

  repo_root="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  workdir="$repo_root/.ai-worktrees/issue-7"
  mkdir -p "$workdir"
  trap "rm -rf '$workdir'" EXIT

  run env PATH="$fake_bin:$PATH" OWNER_REPO= scripts/ai-pr-review-poll 42 7

  [ "$status" -eq 1 ]
  [[ "$output" == *"could not determine owner/repo"* ]]
}
