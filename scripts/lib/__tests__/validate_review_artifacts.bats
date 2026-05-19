#!/usr/bin/env bats

# Tests for the validate_review_artifacts function in scripts/ai-run-issue-v2.
# See: scripts/ai-run-issue-v2 — validate_review_artifacts()

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  # Extract the function using awk brace-counting (robust against } inside heredocs).
  eval "$(awk '
    /^validate_review_artifacts\(\)/ { found=1 }
    found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) exit }
  ' "$SCRIPT_PATH")"
  TMPDIR_TEST="$(mktemp -d)"
}

teardown() {
  rm -rf "$TMPDIR_TEST"
}

@test "both files present → valid" {
  touch "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/test.md"
  run validate_review_artifacts "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/test.md"
  [ "$status" -eq 0 ]
}

@test "neither file present → valid (orchestrator handles no-result elsewhere)" {
  run validate_review_artifacts "$TMPDIR_TEST/missing.result" "$TMPDIR_TEST/missing.md"
  [ "$status" -eq 0 ]
}

@test ".result present, .md missing → invalid" {
  touch "$TMPDIR_TEST/test.result"
  run validate_review_artifacts "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/missing.md"
  [ "$status" -eq 1 ]
}

@test ".md present, .result missing → valid (extractor handles)" {
  touch "$TMPDIR_TEST/test.md"
  run validate_review_artifacts "$TMPDIR_TEST/missing.result" "$TMPDIR_TEST/test.md"
  [ "$status" -eq 0 ]
}

@test ".result says FAIL, .md missing → invalid" {
  echo "QUALITY_FAIL" > "$TMPDIR_TEST/test.result"
  run validate_review_artifacts "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/missing.md"
  [ "$status" -eq 1 ]
}
