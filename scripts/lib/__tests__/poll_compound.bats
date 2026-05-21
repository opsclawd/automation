#!/usr/bin/env bats

setup() {
  TMPDIR_TEST="$(mktemp -d)"
  export ISSUES_DIR="${TMPDIR_TEST}/poll-pr-99"
  mkdir -p "$ISSUES_DIR"
  export PROCESSED_IDS_FILE="${ISSUES_DIR}/processed-comment-ids.txt"
  export REPLIED_IDS_FILE="${ISSUES_DIR}/replied-comment-ids.txt"
  touch "$PROCESSED_IDS_FILE" "$REPLIED_IDS_FILE"
  export TOTAL_POLLS=1
  export BLOCKED_EXIT=false
  export COMMITS_PUSHED=0
  export CONTRADICTION_FIRED=false
  # shellcheck source=../poll_compound.sh
  source "${BATS_TEST_DIRNAME}/../poll_compound.sh"
}

teardown() { rm -rf "$TMPDIR_TEST"; }

@test "should_emit_compound: false when loop did nothing" {
  run should_emit_compound
  [ "$status" -ne 0 ]
}

@test "should_emit_compound: true when commits were pushed" {
  COMMITS_PUSHED=1
  run should_emit_compound
  [ "$status" -eq 0 ]
}

@test "should_emit_compound: true when multiple polls ran" {
  TOTAL_POLLS=2
  run should_emit_compound
  [ "$status" -eq 0 ]
}

@test "should_emit_compound: true when blocked" {
  BLOCKED_EXIT=true
  run should_emit_compound
  [ "$status" -eq 0 ]
}

@test "should_emit_compound: true when contradiction fired" {
  CONTRADICTION_FIRED=true
  run should_emit_compound
  [ "$status" -eq 0 ]
}

@test "should_emit_compound: true when any comments were processed" {
  echo "123456" >> "$PROCESSED_IDS_FILE"
  run should_emit_compound
  [ "$status" -eq 0 ]
}

@test "emit_compound_doc: writes timestamped file under ISSUES_DIR" {
  export PR_NUMBER=99
  export PR_BRANCH=test-branch
  export OWNER_REPO=owner/repo
  # stub run_agent so the test doesn't shell out
  run_agent() {
    local phase="$1"; local timeout="$2"
    cat > "${ISSUES_DIR}/${phase}.prompt.txt"
    echo "stubbed agent output" > "${COMPOUND_OUT}"
    return 0
  }
  export -f run_agent
  COMMITS_PUSHED=1
  emit_compound_doc
  local files
  files=$(ls "${ISSUES_DIR}"/compound-*.md 2>/dev/null | wc -l | tr -d ' ')
  [ "$files" -eq 1 ]
}

@test "emit_compound_doc: two invocations produce two distinct files" {
  export PR_NUMBER=99
  export PR_BRANCH=test-branch
  export OWNER_REPO=owner/repo
  run_agent() {
    cat > "${ISSUES_DIR}/$1.prompt.txt"
    echo "stub" > "${COMPOUND_OUT}"
    return 0
  }
  export -f run_agent
  COMMITS_PUSHED=1
  emit_compound_doc
  sleep 1  # ensure distinct ISO-second timestamps
  emit_compound_doc
  local files
  files=$(ls "${ISSUES_DIR}"/compound-*.md 2>/dev/null | wc -l | tr -d ' ')
  [ "$files" -eq 2 ]
}

@test "emit_compound_doc: filename matches compound-<ISO-timestamp>.md pattern" {
  export PR_NUMBER=99
  export PR_BRANCH=test-branch
  export OWNER_REPO=owner/repo
  run_agent() {
    cat > "${ISSUES_DIR}/$1.prompt.txt"
    echo "stub" > "${COMPOUND_OUT}"
    return 0
  }
  export -f run_agent
  COMMITS_PUSHED=1
  emit_compound_doc
  local f
  f=$(basename "$(ls "${ISSUES_DIR}"/compound-*.md)")
  [[ "$f" =~ ^compound-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z\.md$ ]]
}
