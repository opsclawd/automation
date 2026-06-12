#!/usr/bin/env bats

# Tests for the validate_review_artifacts function in scripts/ai-run-issue-v2.
# See: scripts/ai-run-issue-v2 — validate_review_artifacts()

setup() {
  SCRIPT_PATH="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/ai-run-issue-v2"
  SHARED_LIB="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)/scripts/lib/review-contract.sh"
  source "$SHARED_LIB"
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

@test "both files present, .md non-empty → valid" {
  echo "SPEC_PASS" > "$TMPDIR_TEST/test.result"
  echo "No findings." > "$TMPDIR_TEST/test.md"
  run validate_review_artifacts "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/test.md" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 0 ]
}

@test "neither file present → invalid" {
  run validate_review_artifacts "$TMPDIR_TEST/missing.result" "$TMPDIR_TEST/missing.md" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 1 ]
}

@test ".result present, .md missing → invalid" {
  touch "$TMPDIR_TEST/test.result"
  run validate_review_artifacts "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/missing.md" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 1 ]
}

@test ".md present and non-empty, .result missing → valid (extractor handles)" {
  echo "No findings." > "$TMPDIR_TEST/test.md"
  run validate_review_artifacts "$TMPDIR_TEST/missing.result" "$TMPDIR_TEST/test.md" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 0 ]
}

@test ".md present but empty, .result missing → invalid" {
  touch "$TMPDIR_TEST/test.md"
  run validate_review_artifacts "$TMPDIR_TEST/missing.result" "$TMPDIR_TEST/test.md" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 1 ]
}

@test ".result says FAIL, .md missing → invalid" {
  echo "QUALITY_FAIL" > "$TMPDIR_TEST/test.result"
  run validate_review_artifacts "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/missing.md" QUALITY_PASS QUALITY_FAIL
  [ "$status" -eq 1 ]
}

@test ".result present, .md empty → invalid" {
  touch "$TMPDIR_TEST/test.result"
  touch "$TMPDIR_TEST/test.md"
  run validate_review_artifacts "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/test.md" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 1 ]
}
@test ".result present with content, .md empty → invalid" {
  echo "SPEC_FAIL" > "$TMPDIR_TEST/test.result"
  touch "$TMPDIR_TEST/test.md"
  run validate_review_artifacts "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/test.md" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 1 ]
}

# ── Verdict validation (return code 2) ──────────────────────────────────
@test ".result present with valid verdict + .md → valid (return 0)" {
  echo "SPEC_PASS" > "$TMPDIR_TEST/test.result"
  echo "Findings." > "$TMPDIR_TEST/test.md"
  run validate_review_artifacts "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/test.md" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 0 ]
}
@test ".result present with invalid verdict (SPEC_PARTIAL) + .md → invalid (return 2)" {
  echo "SPEC_PARTIAL" > "$TMPDIR_TEST/test.result"
  echo "Findings." > "$TMPDIR_TEST/test.md"
  run validate_review_artifacts "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/test.md" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 2 ]
}
@test ".result present with invalid verdict (QUALITY_PARTIAL) + .md → invalid (return 2)" {
  echo "QUALITY_PARTIAL" > "$TMPDIR_TEST/test.result"
  echo "Findings." > "$TMPDIR_TEST/test.md"
  run validate_review_artifacts "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/test.md" QUALITY_PASS QUALITY_FAIL
  [ "$status" -eq 2 ]
}
@test ".result present with prose content + .md → invalid (return 2)" {
  echo "The quality review found issues." > "$TMPDIR_TEST/test.result"
  echo "Findings." > "$TMPDIR_TEST/test.md"
  run validate_review_artifacts "$TMPDIR_TEST/test.result" "$TMPDIR_TEST/test.md" QUALITY_PASS QUALITY_FAIL
  [ "$status" -eq 2 ]
}
@test ".result missing but .md present → valid (return 0, extractor handles)" {
  echo "No findings." > "$TMPDIR_TEST/test.md"
  run validate_review_artifacts "$TMPDIR_TEST/missing.result" "$TMPDIR_TEST/test.md" SPEC_PASS SPEC_FAIL
  [ "$status" -eq 0 ]
}
