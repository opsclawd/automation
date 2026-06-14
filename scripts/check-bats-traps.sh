#!/usr/bin/env bash
set -euo pipefail

SCAN_DIR="${BATS_TEST_DIR:-scripts/lib/__tests__}"

violations=$(grep -rn 'trap\s\+["'"'"'].*["'"'"']\s\+EXIT' "$SCAN_DIR"/*.bats 2>/dev/null || true)

if [[ -n "$violations" ]]; then
  echo "::error::trap EXIT in bats test body replaces bats' internal EXIT handler, causing silent test failures."
  echo "Violations:"
  echo "$violations"
  echo ""
  echo "Fix: use 'teardown() { rm -rf \"\$TMPDIR_TEST\"; }' at file level,"
  echo "     or run 'rm -rf \"\$test_dir\"' explicitly after assertions (no trap)."
  exit 1
fi
