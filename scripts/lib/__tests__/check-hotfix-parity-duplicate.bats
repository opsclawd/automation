#!/usr/bin/env bats

setup() {
  CHECK_SCRIPT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/check-hotfix-parity-duplicate.sh"

  TMPDIR="$(mktemp -d)"
  FIXTURE_REPO="$TMPDIR/repo"
  mkdir -p "$FIXTURE_REPO"
  git -C "$FIXTURE_REPO" init -q
  git -C "$FIXTURE_REPO" config user.email "test@example.com"
  git -C "$FIXTURE_REPO" config user.name "test"

  mkdir -p "$FIXTURE_REPO/scripts/lib/__tests__"
  echo "main content" > "$FIXTURE_REPO/README.md"
  printf '%s\n' '#!/usr/bin/env bats' '@test "parity[#200]: existing invariant test" {' '  true' '}' > "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"

  git -C "$FIXTURE_REPO" add .
  git -C "$FIXTURE_REPO" commit -q -m "init"
  HEAD_SHA="$(git -C "$FIXTURE_REPO" rev-parse HEAD)"
  git -C "$FIXTURE_REPO" branch origin/main "$HEAD_SHA"

  export BASE_REF=main
  export GIT_DIR="$FIXTURE_REPO/.git"
  export GIT_WORK_TREE="$FIXTURE_REPO"
  export GITHUB_TOKEN="fake-token"

  gh() {
    if [[ "$1" = "pr" && "$2" = "list" ]]; then
      echo -e "${MOCK_PR_LIST:-}"
    fi
  }
  export -f gh

  # Helper: create a divergent branch from origin/main simulating an open PR
  # Usage: add_pr_branch <branch_name> <parity_invariant_id>
  add_pr_branch() {
    local branch="$1" parity_id="$2"
    local orig_head
    orig_head="$(git -C "$FIXTURE_REPO" rev-parse HEAD)"
    git -C "$FIXTURE_REPO" checkout -q "$(git -C "$FIXTURE_REPO" rev-parse origin/main)"
    git -C "$FIXTURE_REPO" checkout -q -b "tmp-${branch}"
    echo "@test \"${parity_id}: test from branch ${branch}\" {" >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
    echo "  true" >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
    echo "}" >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
    git -C "$FIXTURE_REPO" commit -q -am "add ${parity_id}"
    git -C "$FIXTURE_REPO" branch "origin/${branch}" HEAD
    git -C "$FIXTURE_REPO" checkout -q "$orig_head"
    git -C "$FIXTURE_REPO" branch -D "tmp-${branch}" 2>/dev/null || true
  }
}

teardown() {
  rm -rf "$TMPDIR"
  unset MOCK_PR_LIST
  unset CURRENT_PR_NUMBER
  unset GITHUB_TOKEN
}

run_check() {
  run bash "$CHECK_SCRIPT"
}

# --- Test cases ---

@test "passes when no legacy-parity.bats changes" {
  echo "docs change" >> "$FIXTURE_REPO/README.md"
  git -C "$FIXTURE_REPO" commit -q -am "docs only"
  run_check
  [ "$status" -eq 0 ]
  [[ "$output" = *"No legacy-parity.bats changes detected"* ]]
}

@test "passes when legacy-parity.bats changes contain no new parity test additions" {
  # Remove a test (deletion, no added invariant IDs)
  sed -i '/parity\[#200\]/d' "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
  git -C "$FIXTURE_REPO" commit -q -am "remove trailing newline from parity file"
  run_check
  [ "$status" -eq 0 ]
  [[ "$output" = *"No new parity test invariant IDs"* ]]
}

@test "passes when new parity test added and no open PRs exist" {
  echo '@test "parity[#300]: new isolated test" { true }' >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
  git -C "$FIXTURE_REPO" commit -q -am "add parity[#300]"
  run_check
  [ "$status" -eq 0 ]
  [[ "$output" = *"No other open PRs"* ]]
}

@test "passes when new parity test added but no overlap with open PRs" {
  # Create an open PR branch with parity[#400]
  add_pr_branch "feature-a" "parity[#400]"
  export MOCK_PR_LIST="456\tfeature-a"

  # Current PR adds parity[#300] (no overlap with PR #456's parity[#400])
  echo '@test "parity[#300]: unique test" { true }' >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
  git -C "$FIXTURE_REPO" commit -q -am "add parity[#300]"

  run_check
  [ "$status" -eq 0 ]
}

@test "fails when new parity test invariant ID overlaps with an open PR" {
  # Create an open PR branch with parity[#500]
  add_pr_branch "feature-b" "parity[#500]"
  export MOCK_PR_LIST="789\tfeature-b"

  # Current PR also adds parity[#500] (cherry-pick scenario)
  echo '@test "parity[#500]: cherry-picked test" { true }' >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
  git -C "$FIXTURE_REPO" commit -q -am "cherry-pick parity[#500]"

  run_check
  [ "$status" -eq 1 ]
  [[ "$output" = *"Cherry-picked parity test(s) detected"* ]]
  [[ "$output" = *"parity[#500]"* ]]
  [[ "$output" = *"PR #789"* ]]
}

@test "fails when multiple parity tests added and at least one overlaps" {
  add_pr_branch "feature-c" "parity[#600]"
  export MOCK_PR_LIST="111\tfeature-c"

  # Current PR adds two tests, one overlapping
  echo '@test "parity[#500]: safe test" { true }' >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
  echo '@test "parity[#600]: overlapping test" { true }' >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
  git -C "$FIXTURE_REPO" commit -q -am "add parity[#500] and parity[#600]"

  run_check
  [ "$status" -eq 1 ]
  [[ "$output" = *"parity[#600]"* ]]
  # parity[#500] should NOT appear in the error
  ! grep -q "parity\[#500\] appears in" <<< "$output"
}

@test "passes when open PR branch is deleted/absent from origin" {
  # Open PR #333 claims branch 'gone-branch' but it was already deleted
  export MOCK_PR_LIST="333\tgone-branch"

  echo '@test "parity[#700]: test after branch gone" { true }' >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
  git -C "$FIXTURE_REPO" commit -q -am "add parity[#700]"

  run_check
  [ "$status" -eq 0 ]
  [[ "$output" = *"Skipping PR #333"* ]]
}

@test "passes (graceful) when gh pr list fails" {
  gh() { return 1; }
  export -f gh

  echo '@test "parity[#800]: test" { true }' >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
  git -C "$FIXTURE_REPO" commit -q -am "add parity[#800]"

  run_check
  [ "$status" -eq 0 ]
  [[ "$output" = *"Could not list open PRs"* ]]
}

@test "excludes current PR from overlap check" {
  # Current PR #555 adds parity[#900]
  # Another open PR #888 has the same parity test on branch feature-z
  add_pr_branch "feature-z" "parity[#900]"
  export MOCK_PR_LIST="555\thotfix-xyz\n888\tfeature-z"
  export CURRENT_PR_NUMBER=555

  echo '@test "parity[#900]: current PR test" { true }' >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
  git -C "$FIXTURE_REPO" commit -q -am "add parity[#900]"

  run_check
  # Current PR #555 should be skipped; PR #888 has parity[#900] on branch feature-z
  [ "$status" -eq 1 ]
  [[ "$output" = *"parity[#900]"* ]]
  [[ "$output" = *"PR #888"* ]]
  ! [[ "$output" = *"PR #555"* ]]
}

@test "passes when diff command fails (graceful degradation)" {
  # Corrupt the repo so git diff fails
  rm -rf "$FIXTURE_REPO/.git/objects"
  run_check
  [ "$status" -eq 0 ]
  [[ "$output" = *"skipped"* ]]
}

@test "extracts multi-issue invariant IDs like parity[#279/#280]" {
  add_pr_branch "feature-multi" "parity[#279/#280]"
  export MOCK_PR_LIST="321\tfeature-multi"

  echo '@test "parity[#279/#280]: multi-issue test" { true }' >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
  git -C "$FIXTURE_REPO" commit -q -am "cherry-pick parity[#279/#280]"

  run_check
  [ "$status" -eq 1 ]
  [[ "$output" = *"parity[#279/#280]"* ]]
}

@test "skips current PR using CURRENT_PR_NUMBER when only PR is self" {
  export MOCK_PR_LIST="999\tself-branch"
  export CURRENT_PR_NUMBER=999

  echo '@test "parity[#1000]: self-only test" { true }' >> "$FIXTURE_REPO/scripts/lib/__tests__/legacy-parity.bats"
  git -C "$FIXTURE_REPO" commit -q -am "add parity[#1000]"

  run_check
  [ "$status" -eq 0 ]
  [[ "$output" = *"check passed"* ]]
}
