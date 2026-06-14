#!/usr/bin/env bash
set -euo pipefail

_sq="'"
_trap_re="trap[[:space:]]+(${_sq}[^']*${_sq}[[:space:]]+|\"[^\"]*\"[[:space:]]+|[^[:space:]]+[[:space:]]+)?([Ee][Xx][Ii][Tt]|0)"

if [[ -n "${BATS_TEST_DIR:-}" ]]; then
  violations=$(find "$BATS_TEST_DIR" -type f -name '*.bats' -exec grep -HniE "$_trap_re" {} + 2>/dev/null || true)
else
  violations=$(git ls-files '*.bats' | grep -v 'check-bats-traps.bats' | xargs grep -HniE "$_trap_re" 2>/dev/null || true)
fi

if [[ -n "$violations" ]]; then
  echo "::error::trap EXIT in bats test body replaces bats' internal EXIT handler, causing silent test failures."
  echo "Violations:"
  echo "$violations"
  echo ""
  echo "Fix: use 'teardown() { rm -rf \"\$TMPDIR_TEST\"; }' at file level,"
  echo "     or run 'rm -rf \"\$test_dir\"' explicitly after assertions (no trap)."
  exit 1
fi
