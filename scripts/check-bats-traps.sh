#!/usr/bin/env bash
set -euo pipefail

_sq="'"
_trap_opts="(-[[:alpha:]]+[[:space:]]+|--[[:space:]]+)*"
_trap_re="trap[[:space:]]+${_trap_opts}(${_sq}[^']*${_sq}[[:space:]]+|\"[^\"]*\"[[:space:]]+|[^[:space:]]+[[:space:]]+)?([Ee][Xx][Ii][Tt]|0)"
_filter_p='trap[[:space:]]+(-[b-oq-zA-Z]+[[:space:]]+)*(-[a-zA-Z]*p[a-zA-Z]*)([[:space:]]|$)'

if [[ -n "${BATS_TEST_DIR:-}" ]]; then
  violations=$(find "$BATS_TEST_DIR" -type f -name '*.bats' -exec grep -HniE "$_trap_re" {} + 2>/dev/null | grep -vE "$_filter_p" || true)
else
  violations=$(git ls-files '*.bats' | grep -v 'check-bats-traps.bats' | xargs grep -HniE "$_trap_re" 2>/dev/null | grep -vE "$_filter_p" || true)
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
