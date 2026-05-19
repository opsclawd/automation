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
echo "SPEC_PASS" > "$TMPDIR/test2.result"
rm -f "$TMPDIR/test2.md"
assert_result "stale result without md falls through to fallback" "SPEC_FAIL" \
  resolve_result "$TMPDIR/test2.result" "$TMPDIR/test2.md" SPEC_PASS SPEC_FAIL "SPEC_FAIL"

# Test 3: Neither file present → returns fallback
rm -f "$TMPDIR/test3.result" "$TMPDIR/test3.md"
assert_result "no files returns fallback" "DONE" \
  resolve_result "$TMPDIR/test3.result" "$TMPDIR/test3.md" DONE BLOCKED "DONE"

# Test 4: .result present with FAIL value, .md missing → falls through to fallback
echo "QUALITY_FAIL" > "$TMPDIR/test4.result"
rm -f "$TMPDIR/test4.md"
assert_result "stale FAIL result without md falls through to fallback" "QUALITY_FAIL" \
  resolve_result "$TMPDIR/test4.result" "$TMPDIR/test4.md" QUALITY_PASS QUALITY_FAIL "QUALITY_FAIL"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
exit "$FAIL"
