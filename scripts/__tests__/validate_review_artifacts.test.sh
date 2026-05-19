#!/usr/bin/env bash
# Tests for validate_review_artifacts function
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Extract the function using awk brace-counting to find the matching closing brace.
# This is robust against any line starting with } inside the function body.
source <(awk '
  /^validate_review_artifacts\(\)/ { found=1 }
  found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) exit }
' "${SCRIPT_DIR}/../ai-run-issue-v2")
PASS=0
FAIL=0
assert_return() {
  local description="$1"
  local expected="$2"
  shift 2
  local actual
  "$@" && actual=0 || actual=1
  if [[ "$actual" -eq "$expected" ]]; then
    echo "PASS: ${description}"
    PASS=$((PASS + 1))
  else
    echo "FAIL: ${description} (expected return=${expected}, got return=${actual})"
    FAIL=$((FAIL + 1))
  fi
}
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
# Test 1: Both files present → valid (return 0)
touch "$TMPDIR/test.result" "$TMPDIR/test.md"
assert_return "both files present → valid" 0 validate_review_artifacts "$TMPDIR/test.result" "$TMPDIR/test.md"
# Test 2: Neither file present → valid (return 0) — orchestrator handles "no result" elsewhere
rm -f "$TMPDIR/test.result" "$TMPDIR/test.md"
assert_return "neither file present → valid" 0 validate_review_artifacts "$TMPDIR/test.result" "$TMPDIR/test.md"
# Test 3: .result present, .md missing → INVALID (return 1)
touch "$TMPDIR/test.result"
rm -f "$TMPDIR/test.md"
assert_return "result without md → invalid" 1 validate_review_artifacts "$TMPDIR/test.result" "$TMPDIR/test.md"
# Test 4: .md present, .result missing → valid (return 0) — extractor handles this case
rm -f "$TMPDIR/test.result"
touch "$TMPDIR/test.md"
assert_return "md without result → valid (extractor handles)" 0 validate_review_artifacts "$TMPDIR/test.result" "$TMPDIR/test.md"
# Test 5: .result says FAIL, .md missing → INVALID (return 1)
echo "QUALITY_FAIL" > "$TMPDIR/test.result"
rm -f "$TMPDIR/test.md"
assert_return "FAIL result without md → invalid" 1 validate_review_artifacts "$TMPDIR/test.result" "$TMPDIR/test.md"
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
exit "$FAIL"
