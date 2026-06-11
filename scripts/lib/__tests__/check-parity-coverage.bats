#!/usr/bin/env bats

setup() {
  CHECK_SCRIPT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/check-parity-coverage.sh"

  TMPDIR="$(mktemp -d)"
  FIXTURE_REPO="$TMPDIR/repo"
  mkdir -p "$FIXTURE_REPO"
  git -C "$FIXTURE_REPO" init -q
  git -C "$FIXTURE_REPO" config user.email "test@example.com"
  git -C "$FIXTURE_REPO" config user.name "test"

  # Baseline commit
  echo "main content" > "$FIXTURE_REPO/README.md"
  mkdir -p "$FIXTURE_REPO/scripts/lib/__tests__"
  mkdir -p "$FIXTURE_REPO/scripts/lib"
  mkdir -p "$FIXTURE_REPO/packages/infrastructure/src/agent"
  mkdir -p "$FIXTURE_REPO/apps/cli/src"
  git -C "$FIXTURE_REPO" add .
  git -C "$FIXTURE_REPO" commit -q -m "init"
  HEAD_SHA="$(git -C "$FIXTURE_REPO" rev-parse HEAD)"

  # Create origin/main remote branch
  git -C "$FIXTURE_REPO" branch origin/main "$HEAD_SHA"

  export BASE_REF=main
  export GIT_DIR="$FIXTURE_REPO/.git"
  export GIT_WORK_TREE="$FIXTURE_REPO"

  # Mock gh for PR body testing
  gh() {
    if [[ "$1" = "pr" && "$2" = "view" ]]; then
      echo "${MOCK_PR_BODY:-}"
    fi
  }
  export -f gh

  # Set PR_BODY env for direct override
  unset PR_BODY
}

teardown() {
  rm -rf "$TMPDIR"
  unset MOCK_PR_BODY
  unset PR_BODY
}

run_check() {
  run bash "$CHECK_SCRIPT"
}

@test "passes when no watched paths changed" {
  echo "docs change" >> "$FIXTURE_REPO/README.md"
  git -C "$FIXTURE_REPO" commit -q -am "docs only"
  run_check
  [ "$status" -eq 0 ]
  [[ "$output" = *"No watched paths changed"* ]]
}

@test "fails when watched path changes with no parity test" {
  mkdir -p "$FIXTURE_REPO/scripts"
  echo "change" >> "$FIXTURE_REPO/scripts/ai-run-issue-v2"
  git -C "$FIXTURE_REPO" add scripts/ai-run-issue-v2
  git -C "$FIXTURE_REPO" commit -q -m "change watched path"
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" = *"Offending paths"* ]]
  [[ "$output" = *"scripts/ai-run-issue-v2"* ]]
}

@test "passes when watched path changes AND parity test file is touched" {
  mkdir -p "$FIXTURE_REPO/scripts"
  echo "change" >> "$FIXTURE_REPO/scripts/ai-run-issue-v2"
  echo "new test" >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
  git -C "$FIXTURE_REPO" add scripts/ai-run-issue-v2 scripts/lib/__tests__/legacy-parity.bats
  git -C "$FIXTURE_REPO" commit -q -m "change + parity test"
  run_check
  [ "$status" -eq 0 ]
}

@test "passes when watched path changes AND parity-[...].bats is touched" {
  echo "change" >> "$FIXTURE_REPO/apps/cli/src/run-agent.ts"
  echo "@test \"parity[#300]: new test\" {}" >> "$FIXTURE_REPO/scripts/lib/__tests__/parity-coverage.bats"
  git -C "$FIXTURE_REPO" add apps/cli/src/run-agent.ts scripts/lib/__tests__/parity-coverage.bats
  git -C "$FIXTURE_REPO" commit -q -m "change + parity file"
  run_check
  [ "$status" -eq 0 ]
}

@test "passes when watched path changes AND a .bats diff adds parity[# tag" {
  echo "change" >> "$FIXTURE_REPO/scripts/ai-run-issue-v2"
  echo "@test \"parity[#300]: something\" {" >> "$FIXTURE_REPO/scripts/lib/__tests__/fix-review-stash.bats"
  git -C "$FIXTURE_REPO" add scripts/ai-run-issue-v2 scripts/lib/__tests__/fix-review-stash.bats
  git -C "$FIXTURE_REPO" commit -q -m "change + inline parity tag"
  run_check
  [ "$status" -eq 0 ]
}

@test "passes when watched path changes AND PR body has no-parity-impact" {
  export PR_BODY="This is a pure refactor, no-parity-impact"
  echo "change" >> "$FIXTURE_REPO/packages/infrastructure/src/agent/opencode-adapter.ts"
  git -C "$FIXTURE_REPO" add packages/infrastructure/src/agent/opencode-adapter.ts
  git -C "$FIXTURE_REPO" commit -q -m "refactor agent"
  run_check
  [ "$status" -eq 0 ]
  [[ "$output" = *"no-parity-impact declared"* ]]
}

@test "handles case-insensitive no-parity-impact in PR body" {
  export PR_BODY="chore: NO-PARITY-IMPACT refactor"
  echo "change" >> "$FIXTURE_REPO/packages/infrastructure/src/agent/agent-runtime-router.ts"
  git -C "$FIXTURE_REPO" add packages/infrastructure/src/agent/agent-runtime-router.ts
  git -C "$FIXTURE_REPO" commit -q -m "chore"
  run_check
  [ "$status" -eq 0 ]
}

@test "excludes scripts/lib/__tests__/ from watched paths" {
  echo "change" >> "$FIXTURE_REPO/scripts/lib/__tests__/arbiter_validation.bats"
  git -C "$FIXTURE_REPO" add scripts/lib/__tests__/arbiter_validation.bats
  git -C "$FIXTURE_REPO" commit -q -m "test only"
  run_check
  [ "$status" -eq 0 ]
  [[ "$output" = *"No watched paths changed"* ]]
}

@test "excludes packages/infrastructure/src/agent/__tests__/ from watched paths" {
  mkdir -p "$FIXTURE_REPO/packages/infrastructure/src/agent/__tests__"
  echo "change" >> "$FIXTURE_REPO/packages/infrastructure/src/agent/__tests__/example.ts"
  git -C "$FIXTURE_REPO" add packages/infrastructure/src/agent/__tests__/example.ts
  git -C "$FIXTURE_REPO" commit -q -m "test only"
  run_check
  [ "$status" -eq 0 ]
  [[ "$output" = *"No watched paths changed"* ]]
}

@test "watches packages/infrastructure/src/agent/ prefix" {
  echo "change" >> "$FIXTURE_REPO/packages/infrastructure/src/agent/claude-code-adapter.ts"
  git -C "$FIXTURE_REPO" add packages/infrastructure/src/agent/claude-code-adapter.ts
  git -C "$FIXTURE_REPO" commit -q -m "agent change"
  run_check
  [ "$status" -eq 1 ]
}

@test "watches scripts/lib/ files (not __tests__)" {
  echo "change" >> "$FIXTURE_REPO/scripts/lib/review-manifest-helpers.sh"
  git -C "$FIXTURE_REPO" add scripts/lib/review-manifest-helpers.sh
  git -C "$FIXTURE_REPO" commit -q -m "lib change"
  run_check
  [ "$status" -eq 1 ]
}

@test "failure message links #210 and names offending paths" {
  echo "change" >> "$FIXTURE_REPO/scripts/ai-run-issue-v2"
  echo "other change" >> "$FIXTURE_REPO/apps/cli/src/run-agent.ts"
  git -C "$FIXTURE_REPO" add scripts/ai-run-issue-v2 apps/cli/src/run-agent.ts
  git -C "$FIXTURE_REPO" commit -q -m "multi watched"
  run_check
  [ "$status" -eq 1 ]
  [[ "$output" = *"issues/210"* ]]
  [[ "$output" = *"scripts/ai-run-issue-v2"* ]]
  [[ "$output" = *"run-agent.ts"* ]]
}

@test "passes when nothing changed (empty diff)" {
  # No new commits — HEAD == origin/main
  run_check
  [ "$status" -eq 0 ]
}
