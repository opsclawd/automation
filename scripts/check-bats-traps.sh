#!/usr/bin/env bash
set -euo pipefail

SCAN_DIR="${BATS_TEST_DIR:-.}"

violations=$(find "$SCAN_DIR" -type f -name '*.bats' ! -name 'check-bats-traps.bats' -exec grep -Hn 'trap\s\+\('"'"'[^'"'"']*'"'"'\|"[^"]*"\|\S\+\)\s\+EXIT' {} + 2>/dev/null || true)

if [[ -n "$violations" ]]; then
  echo "::error::trap EXIT in bats test body replaces bats' internal EXIT handler, causing silent test failures."
  echo "Violations:"
  echo "$violations"
  echo ""
  echo "Fix: use 'teardown() { rm -rf \"\$TMPDIR_TEST\"; }' at file level,"
  echo "     or run 'rm -rf \"\$test_dir\"' explicitly after assertions (no trap)."
  exit 1
fi
