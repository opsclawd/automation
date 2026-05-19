#!/usr/bin/env bash
# Tests for resolve_result stale-result detection
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Extract required functions using awk brace-counting
source <(awk '
  /^(validate_result_file|read_result_value|resolve_result)\(\)/ { found=1 }
  found { print; if (/\{/) depth+=gsub(/{/,"{"); if (/\}/) depth-=gsub(/}/,"}"); if (depth==0 && found) { found=0; depth=0 } }
' "${SCRIPT_DIR}/../ai-run-issue-v2")

# Stub functions that resolve_result depends on
log() { :; }
orchestrator_fail() { echo "BLOCKED: $*"; exit 1; }
extract_result() { return 1; }

PASS=0
FAIL=0

assert_result() {
  local description="$1"
  local expected="$2"
  shift 2
  local actual
  actual=$("$@" 2>/dev/null) || true
  if [[ "$actual" == "$expected" ]]; then
    echo "PASS: ${description}"
    PASS=$((PASS + 1))
  else
    echo "FAIL: ${description} (expected='${expected}', got='${actual}')"
    FAIL=$((FAIL + 1))
  fi
}

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Test 1: .result present with valid value, .md present → returns the result value
echo "SPEC_PASS" > "$TMPDIR/test.result"
touch "$TMPDIR/test.md"
assert_result "valid pair returns result value" "SPEC_PASS" \
  resolve_result "$TMPDIR/test.result" "$TMPDIR/test.md" SPEC_PASS SPEC_FAIL "SPEC_FAIL"

# Test 2: .result present, .md missing → falls through to fallback (does NOT return stale value)
# Uses spec-review-task filename pattern so the stale-result guard applies
echo "SPEC_PASS" > "$TMPDIR/spec-review-task-1.result"
rm -f "$TMPDIR/spec-review-task-1.md"
assert_result "stale result without md falls through to fallback" "SPEC_FAIL" \
  resolve_result "$TMPDIR/spec-review-task-1.result" "$TMPDIR/spec-review-task-1.md" SPEC_PASS SPEC_FAIL "SPEC_FAIL"

# Test 3: Neither file present → returns fallback
rm -f "$TMPDIR/test3.result" "$TMPDIR/test3.md"
assert_result "no files returns fallback" "DONE" \
  resolve_result "$TMPDIR/test3.result" "$TMPDIR/test3.md" DONE BLOCKED "DONE"

# Test 4: .result present with FAIL value, .md missing → falls through to fallback
# Uses quality-review-task filename pattern so the stale-result guard applies
echo "QUALITY_FAIL" > "$TMPDIR/quality-review-task-1.result"
rm -f "$TMPDIR/quality-review-task-1.md"
assert_result "stale FAIL result without md falls through to fallback" "QUALITY_FAIL" \
  resolve_result "$TMPDIR/quality-review-task-1.result" "$TMPDIR/quality-review-task-1.md" QUALITY_PASS QUALITY_FAIL "QUALITY_FAIL"

# Test 5: Implementer .result without .md → returns the result value (guard does NOT apply)
# Implementer tasks only write .result, not .md — stale guard must not ignore valid statuses
echo "BLOCKED" > "$TMPDIR/implement-task-1.result"
rm -f "$TMPDIR/implement-task-1.md"
assert_result "implementer result without md returns result value" "BLOCKED" \
  resolve_result "$TMPDIR/implement-task-1.result" "$TMPDIR/implement-task-1.md" DONE DONE_WITH_CONCERNS BLOCKED NEEDS_CONTEXT "DONE"

# Test 6: Fix-review .result without .md → returns the result value (guard does NOT apply)
# Fix-review tasks only write .result, not .md — stale guard must not ignore valid statuses
echo "DONE_NO_FIXES_NEEDED" > "$TMPDIR/fix-review-task-1.result"
rm -f "$TMPDIR/fix-review-task-1.md"
assert_result "fix-review result without md returns result value" "DONE_NO_FIXES_NEEDED" \
  resolve_result "$TMPDIR/fix-review-task-1.result" "$TMPDIR/fix-review-task-1.md" DONE DONE_NO_FIXES_NEEDED BLOCKED "DONE"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
exit "$FAIL"
